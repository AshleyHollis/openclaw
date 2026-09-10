import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  fsyncSync,
  readSync,
} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { openRootFile, readFileDescriptorBoundedSync } from "../../src/infra/boundary-file-read.js";
import {
  pinDirectory,
  publishFileExclusive,
  requireDirectorySync,
  syncDirectory,
} from "../../src/infra/directory-durability.js";
import { assertLosslessReserialization } from "./offline-session-json.mts";

export type OfflineSessionFileContent = { sha256: string; sizeBytes: number };
type OfflineSessionFileIdentity = { dev: string; ino: string };
const MAX_OFFLINE_RECORD_BYTES = 4 * 1024 * 1024;

function offlineBytesContent(bytes: Buffer): OfflineSessionFileContent {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}

/** Reject aliases, including existing ancestors of a not-yet-created output. */
export async function assertUnaliasedOfflinePath(filePath: string): Promise<void> {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) {
    throw new Error("Offline artifact path must be canonical and unaliased.");
  }
  let existing = filePath;
  while (true) {
    try {
      const stat = await fs.lstat(existing);
      if (stat.isSymbolicLink() || (await fs.realpath(existing)) !== existing) {
        throw new Error("Offline artifact path is aliased.");
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw new Error("Offline artifact has no verifiable canonical ancestor.", { cause: error });
      }
      existing = parent;
    }
  }
}

async function admittedFile(filePath: string, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Invalid offline file bound.");
  }
  await assertUnaliasedOfflinePath(filePath);
  const opened = await openRootFile({
    rootPath: path.dirname(filePath),
    absolutePath: filePath,
    boundaryLabel: "offline Session artifact",
    rejectHardlinks: true,
    rejectSymlinks: true,
    maxBytes,
  });
  if (!opened.ok) {
    throw new Error("Offline artifact is absent, unsafe or unreadable.");
  }
  return opened;
}

/** Hash original or staged bytes without loading an entire database into memory. */
export async function inspectOfflineSessionFile(
  filePath: string,
  maxBytes: number,
  durable = false,
) {
  const opened = await admittedFile(filePath, maxBytes);
  try {
    const initial = fstatSync(opened.fd, { bigint: true });
    if (initial.size > BigInt(maxBytes)) {
      throw new Error("Offline artifact exceeds its bound.");
    }
    const sizeBytes = Number(initial.size);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < sizeBytes) {
      const count = readSync(
        opened.fd,
        buffer,
        0,
        Math.min(buffer.length, sizeBytes - offset),
        offset,
      );
      if (!count) {
        throw new Error("Offline artifact was truncated.");
      }
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(opened.fd, { bigint: true });
    const named = await fs.lstat(filePath, { bigint: true });
    if (
      after.size !== initial.size ||
      after.mtimeNs !== initial.mtimeNs ||
      after.ctimeNs !== initial.ctimeNs ||
      after.nlink !== 1n ||
      named.isSymbolicLink() ||
      named.dev !== after.dev ||
      named.ino !== after.ino
    ) {
      throw new Error("Offline artifact changed during inspection.");
    }
    if (durable) {
      fsyncSync(opened.fd);
      requireDirectorySync(await syncDirectory(path.dirname(filePath)), "Offline artifact");
    }
    return { content: { sha256: hash.digest("hex"), sizeBytes }, identity: initial };
  } finally {
    closeSync(opened.fd);
  }
}

export async function verifyOfflineSessionFile(
  filePath: string,
  expected: OfflineSessionFileContent,
  durable = false,
  expectedIdentity?: OfflineSessionFileIdentity,
) {
  const result = await inspectOfflineSessionFile(filePath, expected.sizeBytes, durable);
  if (
    result.content.sha256 !== expected.sha256 ||
    result.content.sizeBytes !== expected.sizeBytes
  ) {
    throw new Error("Offline artifact differs from its expected content.");
  }
  if (
    expectedIdentity &&
    (String(result.identity.dev) !== expectedIdentity.dev ||
      String(result.identity.ino) !== expectedIdentity.ino)
  ) {
    throw new Error("Offline artifact differs from its approved identity.");
  }
  // The sealed publication consumes preparation-owned private files; ordinary
  // source-copy callers keep their existing content-only admission contract.
  if (
    expectedIdentity &&
    process.getuid &&
    ((result.identity.mode & 0o7777n) !== 0o600n ||
      result.identity.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("Offline publication member lost its private ownership or permissions.");
  }
  return result.identity;
}

/** Consume a target-local staged file atomically. Unsupported native capability fails closed. */
export async function publishOfflineSessionArtifact(
  sourcePath: string,
  targetPath: string,
  expected: OfflineSessionFileContent,
  expectedIdentity?: OfflineSessionFileIdentity,
): Promise<void> {
  await assertUnaliasedOfflinePath(targetPath);
  const identity = await verifyOfflineSessionFile(sourcePath, expected, true, expectedIdentity);
  const result = await publishFileExclusive({
    sourcePath,
    targetPath,
    expectedSourceIdentity: identity,
    strategy: "rename-noreplace",
    onSyncFailure: "preserve",
  });
  requireDirectorySync(result.directorySync, "Offline artifact publication");
  requireDirectorySync(
    await syncDirectory(path.dirname(sourcePath)),
    "Offline artifact source removal",
  );
  await verifyOfflineSessionFile(targetPath, expected, true, expectedIdentity);
}

/** Copy from an admitted descriptor, verifying the exact bytes before any final name exists. */
export async function copyOfflineSessionArtifact(
  sourcePath: string,
  targetPath: string,
  expected: OfflineSessionFileContent,
): Promise<void> {
  const parent = await pinDirectory(path.dirname(targetPath));
  const temporary = path.join(parent.receipt.path, `.offline-member-${randomUUID()}`);
  try {
    if (parent.receipt.path !== parent.receipt.realPath) {
      throw new Error("Offline artifact destination parent is aliased.");
    }
    const opened = await admittedFile(sourcePath, expected.sizeBytes);
    try {
      if (!expected.sizeBytes) {
        await fs.writeFile(temporary, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
      } else {
        await pipeline(
          createReadStream(sourcePath, {
            fd: opened.fd,
            autoClose: false,
            start: 0,
            end: expected.sizeBytes - 1,
          }),
          createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        );
      }
    } finally {
      closeSync(opened.fd);
    }
    await parent.assertCurrent();
    await publishOfflineSessionArtifact(temporary, targetPath, expected);
    await parent.assertCurrent();
  } finally {
    await parent.close();
  }
}

function offlineRecordBytes(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_OFFLINE_RECORD_BYTES) {
    throw new Error("Offline record exceeds its bound.");
  }
  return bytes;
}

export async function writeOfflineSessionRecord(filePath: string, value: unknown): Promise<void> {
  const bytes = offlineRecordBytes(value);
  const parent = await pinDirectory(path.dirname(filePath));
  try {
    if (parent.receipt.path !== parent.receipt.realPath) {
      throw new Error("Offline record destination parent is aliased.");
    }
    await parent.assertCurrent();
    const temporary = path.join(parent.receipt.path, `.record-${randomUUID()}`);
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await parent.assertCurrent();
    await publishOfflineSessionArtifact(temporary, filePath, offlineBytesContent(bytes));
  } finally {
    await parent.close();
  }
}

/** Read records with no alias, rounding, duplicate-key, or invalid UTF-8 ambiguity. */
export async function readOfflineSessionRecord(
  filePath: string,
): Promise<{ value: unknown; sha256: string }> {
  const opened = await admittedFile(filePath, MAX_OFFLINE_RECORD_BYTES);
  let bytes: Buffer;
  try {
    bytes = readFileDescriptorBoundedSync(opened.fd, MAX_OFFLINE_RECORD_BYTES);
  } finally {
    closeSync(opened.fd);
  }
  const content = offlineBytesContent(bytes);
  await verifyOfflineSessionFile(filePath, content);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  assertLosslessReserialization(text);
  return { value, sha256: content.sha256 };
}
