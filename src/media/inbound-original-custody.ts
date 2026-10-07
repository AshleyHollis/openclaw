import { createHash } from "node:crypto";
import fsSync, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { acquireFileLock } from "../infra/file-lock.js";

const MAX_ORIGINAL_BYTES = 5 * 1024 * 1024;

/** Native directory identity covers case aliases without folding distinct custom buckets. */
export async function isInboundOriginalDirectory(
  mediaRoot: string,
  directory: string,
): Promise<boolean> {
  const inbound = path.join(path.resolve(mediaRoot), "inbound");
  if (path.resolve(directory) === inbound) {
    return true;
  }
  const scoped = await fs.stat(directory, { bigint: true });
  let original: BigIntStats;
  try {
    original = await fs.stat(inbound, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  return scoped.isDirectory() && original.isDirectory() && sameIdentity(scoped, original);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function assertDirectory(filePath: string, expected: BigIntStats): void {
  const current = fsSync.lstatSync(filePath, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, expected)) {
    throw new Error("Inbound original directory changed");
  }
}

async function captureMediaRoot(mediaRoot: string) {
  const requested = path.resolve(mediaRoot);
  const canonical = await fs.realpath(requested);
  const identity = await fs.lstat(canonical, { bigint: true });
  const assertCurrent = () => {
    if (fsSync.realpathSync(requested) !== canonical) {
      throw new Error("Inbound media root changed");
    }
    assertDirectory(canonical, identity);
  };
  assertCurrent();
  return { canonical, assertCurrent };
}

/** One native inbound owner excludes deletion/pruning while a publication joins its source worker. */
export async function withInboundOriginalMutation<T>(
  mediaRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const root = await captureMediaRoot(mediaRoot);
  // Keep the sidecar outside every media subtree swept by cleanOldMedia.
  const lockTarget = path.join(
    path.dirname(root.canonical),
    `.${path.basename(root.canonical)}-inbound-original-custody`,
  );
  const lock = await acquireFileLock(lockTarget, {
    stale: 30_000,
    staleRecovery: "fail-closed",
    retries: { retries: 1500, factor: 1, minTimeout: 20, maxTimeout: 20, randomize: false },
  });
  try {
    root.assertCurrent();
    return await operation();
  } finally {
    await lock.release();
  }
}

export type PreparedInboundOriginalCustody = Readonly<{
  mediaId: string;
  digest: string;
  sizeBytes: number;
  /** Staging bytes are a copy, never an admission or a mutable view into this owner's bytes. */
  getBytes(): Buffer;
  withCustody<T>(operation: (assertOriginalCurrent: () => void) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}>;

function sameOriginal(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    !left.isSymbolicLink() &&
    left.nlink === 1n &&
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Private native input: the media owner resolves mediaRoot; consumers supply no filesystem locator. */
export async function prepareInboundOriginalCustody(
  input: {
    mediaRoot: string;
    mediaId: string;
    digest: string;
    sizeBytes: number;
    maxBytes?: number;
  },
  assertInvocation: () => void,
): Promise<PreparedInboundOriginalCustody> {
  const { mediaId, digest, sizeBytes } = input;
  const maxBytes = input.maxBytes ?? MAX_ORIGINAL_BYTES;
  if (
    !mediaId ||
    mediaId === "." ||
    mediaId === ".." ||
    /[\\/\0]/u.test(mediaId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(digest) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > MAX_ORIGINAL_BYTES ||
    sizeBytes > maxBytes
  ) {
    throw new Error("Inbound original custody identity or byte bound is invalid");
  }
  assertInvocation();
  const root = await captureMediaRoot(input.mediaRoot);
  const inboundDir = path.join(root.canonical, "inbound");
  const directory = await fs.lstat(inboundDir, { bigint: true });
  assertDirectory(inboundDir, directory);
  const filePath = path.join(inboundDir, mediaId);
  let handle: FileHandle | undefined;
  let transferred = false;
  try {
    handle = await fs.open(
      filePath,
      fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK,
    );
    const retained = handle;
    const original = await retained.stat({ bigint: true });
    if (!original.isFile() || original.nlink !== 1n || original.size !== BigInt(sizeBytes)) {
      throw new Error("Inbound original is unsafe or differs from its prepared size");
    }
    const assertIdentity = () => {
      assertInvocation();
      root.assertCurrent();
      assertDirectory(inboundDir, directory);
      const opened = fsSync.fstatSync(retained.fd, { bigint: true });
      const named = fsSync.lstatSync(filePath, { bigint: true });
      if (!sameOriginal(opened, original) || !sameOriginal(named, original)) {
        throw new Error("Inbound original was removed, replaced, or changed");
      }
    };
    const bytes = Buffer.alloc(sizeBytes + 1);
    let read = 0;
    while (read < bytes.length) {
      const result = await retained.read(bytes, read, bytes.length - read, read);
      if (result.bytesRead === 0) {
        break;
      }
      read += result.bytesRead;
    }
    assertIdentity();
    if (
      read !== sizeBytes ||
      `sha256:${createHash("sha256").update(bytes.subarray(0, read)).digest("hex")}` !== digest
    ) {
      throw new Error("Inbound original bytes differ from their prepared digest");
    }
    const originalBytes = bytes.subarray(0, sizeBytes);
    let active = true;
    let used = false;
    let held = false;
    let pending: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    const assertActive = () => {
      if (!active) {
        throw new Error("Inbound original custody is closed");
      }
      assertInvocation();
    };
    const capability: PreparedInboundOriginalCustody = Object.freeze({
      mediaId,
      digest,
      sizeBytes,
      getBytes() {
        assertActive();
        return Buffer.from(originalBytes);
      },
      async withCustody<T>(operation: (assertOriginalCurrent: () => void) => Promise<T>) {
        assertActive();
        if (used) {
          throw new Error("Inbound original custody was already consumed");
        }
        used = true;
        const work = withInboundOriginalMutation(root.canonical, async () => {
          assertActive();
          held = true;
          const assertOriginalCurrent = () => {
            assertActive();
            if (!held) {
              throw new Error("Inbound original custody callback expired");
            }
            assertIdentity();
            const current = Buffer.alloc(sizeBytes + 1);
            let count = 0;
            while (count < current.length) {
              const chunk = fsSync.readSync(
                retained.fd,
                current,
                count,
                current.length - count,
                count,
              );
              if (chunk === 0) {
                break;
              }
              count += chunk;
            }
            assertIdentity();
            if (
              count !== sizeBytes ||
              `sha256:${createHash("sha256").update(current.subarray(0, count)).digest("hex")}` !==
                digest
            ) {
              throw new Error("Inbound original bytes changed before publication");
            }
          };
          try {
            assertOriginalCurrent();
            return await operation(assertOriginalCurrent);
          } finally {
            held = false;
          }
        });
        pending = work;
        try {
          return await work;
        } finally {
          pending = undefined;
        }
      },
      close() {
        active = false;
        closing ??= (async () => {
          await pending?.catch(() => {});
          await retained.close();
        })();
        return closing;
      },
    });
    transferred = true;
    return capability;
  } finally {
    if (!transferred) {
      await handle?.close();
    }
  }
}
