import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { requireDirectorySync, syncDirectory } from "../../src/infra/directory-durability.js";
import { hasErrnoCode } from "../../src/infra/errno.js";
import { isPathInside } from "../../src/infra/path-guards.js";
import { createPrivateSqliteDirectory } from "../../src/infra/sqlite-private-directory.js";
import { normalizeAgentId } from "../../src/routing/session-key.js";
import {
  assertUnaliasedOfflinePath,
  publishOfflineSessionArtifact as publishStaged,
  readOfflineSessionRecord,
  verifyOfflineSessionFile as verifyFile,
} from "./offline-session-artifacts.mts";

/** Supplied by the preparation owner, never reconstructed from untrusted outputs. */
export type OfflineSessionPublicationIntent = {
  schemaVersion: 1;
  agentId: string;
  inputDigest: string;
  preparationDigest: string;
  members: {
    kind: "database" | "archive";
    sourcePath: string;
    targetPath: string;
    sha256: string;
    sizeBytes: number;
    dev: string;
    ino: string;
  }[];
};

type Options = {
  publicationDir: string;
  intent: OfflineSessionPublicationIntent;
};
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

function exactKeys(value: object, keys: string[]): void {
  if (Object.keys(value).toSorted().join("\n") !== keys.toSorted().join("\n")) {
    throw new Error("Offline publication requires a closed intent contract.");
  }
}

function exactPath(value: string): boolean {
  return typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value;
}

function admittedOptions(options: Options): Options {
  // Capture every value before the first await; callers cannot retarget an in-flight operation.
  const { publicationDir } = options;
  const intent = structuredClone(options.intent);
  exactKeys(intent, ["schemaVersion", "agentId", "inputDigest", "preparationDigest", "members"]);
  if (
    !exactPath(publicationDir) ||
    intent.schemaVersion !== 1 ||
    typeof intent.agentId !== "string" ||
    !intent.agentId ||
    normalizeAgentId(intent.agentId) !== intent.agentId ||
    ![intent.inputDigest, intent.preparationDigest].every(
      (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    ) ||
    !Array.isArray(intent.members) ||
    intent.members.length < 1 ||
    intent.members.length > 4097 ||
    intent.members[0]?.kind !== "database" ||
    intent.members.slice(1).some((member) => member.kind !== "archive")
  ) {
    throw new Error(
      "Offline publication requires exact approved input and preparation identities.",
    );
  }
  const paths = new Set<string>();
  for (const member of intent.members) {
    exactKeys(member, ["kind", "sourcePath", "targetPath", "sha256", "sizeBytes", "dev", "ino"]);
    if (
      !/^[a-f0-9]{64}$/.test(member.sha256) ||
      !Number.isSafeInteger(member.sizeBytes) ||
      member.sizeBytes < 0 ||
      ![member.dev, member.ino].every(
        (value) => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value),
      )
    ) {
      throw new Error("Offline publication requires a bounded exact member inventory.");
    }
    for (const filePath of [member.sourcePath, member.targetPath]) {
      if (
        !exactPath(filePath) ||
        paths.has(filePath) ||
        filePath === publicationDir ||
        isPathInside(publicationDir, filePath) ||
        isPathInside(filePath, publicationDir)
      ) {
        throw new Error("Offline publication paths must be distinct and outside its records.");
      }
      paths.add(filePath);
    }
  }
  return { publicationDir, intent };
}

function metadataBytes(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_METADATA_BYTES) {
    throw new Error("Offline publication metadata exceeds its bounded contract.");
  }
  return bytes;
}

function intentBytes(options: Options): Buffer {
  return metadataBytes({ publicationDir: options.publicationDir, ...options.intent });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function content(bytes: Buffer) {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}

async function verifyMetadata(filePath: string, bytes: Buffer, durable = false): Promise<void> {
  await verifyFile(filePath, content(bytes), durable);
}

async function writeMetadata(filePath: string, bytes: Buffer): Promise<void> {
  await assertUnaliasedOfflinePath(filePath);
  const temporary = path.join(path.dirname(filePath), `.record-${randomUUID()}`);
  await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await publishStaged(temporary, filePath, content(bytes));
}

async function readyBytes(options: Options, durable = false): Promise<Buffer> {
  const outputs = [];
  for (const member of options.intent.members) {
    const stat = await verifyFile(member.targetPath, member, durable, member);
    outputs.push({
      targetPath: member.targetPath,
      sizeBytes: member.sizeBytes,
      sha256: member.sha256,
      dev: String(stat.dev),
      ino: String(stat.ino),
    });
  }
  return metadataBytes({
    schemaVersion: 1,
    status: "verified",
    inputDigest: options.intent.inputDigest,
    preparationDigest: options.intent.preparationDigest,
    intentDigest: content(intentBytes(options)).sha256,
    outputs,
  });
}

async function verifyReady(options: Options, durable = false): Promise<void> {
  await verifyMetadata(
    path.join(options.publicationDir, "intent.json"),
    intentBytes(options),
    durable,
  );
  await verifyMetadata(
    path.join(options.publicationDir, "ready.json"),
    await readyBytes(options, durable),
    durable,
  );
}

/**
 * One preparation-owned publication, called under the preparation owner's lock.
 * Its dedicated offline process must opt in to the pinned fs-safe native helper;
 * this module never changes the shared filesystem configuration for other callers.
 * Caller supplies trusted source/tool identities and the previously sealed inventory.
 * Dedicated staged members are consumed by rename on one writable filesystem/mount;
 * sealed device/inode identity must survive the move. No cross-mount copy fallback.
 * Partial outputs are never overwritten or cleaned up; the same intent can resume.
 */
export async function publishOfflineSessionBundle(supplied: Options): Promise<void> {
  const options = admittedOptions(supplied);
  const { publicationDir, intent } = options;
  const recordedIntent = path.join(publicationDir, "intent.json");
  const ready = path.join(publicationDir, "ready.json");
  const encodedIntent = intentBytes(options);
  if (await exists(recordedIntent)) {
    await verifyMetadata(recordedIntent, encodedIntent, true);
    if (await exists(ready)) {
      await verifyReady(options, true);
      return;
    }
  } else {
    // Validate the whole stage and refuse pre-existing outputs before sealing intent.
    for (const member of intent.members) {
      await verifyFile(member.sourcePath, member, true, member);
      await assertUnaliasedOfflinePath(member.targetPath);
      const destination = await fs.stat(path.dirname(member.targetPath), { bigint: true });
      if (!destination.isDirectory() || String(destination.dev) !== member.dev) {
        throw new Error("Offline publication requires a same-filesystem destination.");
      }
      if (await exists(member.targetPath)) {
        throw new Error("Offline publication cannot adopt a pre-existing output.");
      }
    }
    if (await exists(publicationDir)) {
      const directory = await fs.lstat(publicationDir);
      if (!directory.isDirectory() || (await fs.realpath(publicationDir)) !== publicationDir) {
        throw new Error("Offline intent root must be an exact private directory.");
      }
      for (const name of await fs.readdir(publicationDir)) {
        const entry = await fs.lstat(path.join(publicationDir, name));
        if (!/^\.record-[a-f0-9-]{36}$/.test(name) || !entry.isFile() || entry.nlink !== 1) {
          throw new Error("Offline intent initialization contains conflicting records.");
        }
      }
      // Unpublished private record temporaries are retained, never adopted.
    } else {
      await createPrivateSqliteDirectory(publicationDir);
    }
    requireDirectorySync(await syncDirectory(path.dirname(publicationDir)), "Offline intent root");
    await writeMetadata(recordedIntent, encodedIntent);
  }
  for (const member of intent.members) {
    if (await exists(member.targetPath)) {
      await verifyFile(member.targetPath, member, true, member);
      // A rename may have completed before its source-directory sync was acknowledged.
      requireDirectorySync(
        await syncDirectory(path.dirname(member.sourcePath)),
        "Offline artifact source removal",
      );
    } else {
      await publishStaged(member.sourcePath, member.targetPath, member, member);
    }
  }
  // This is the only success marker. No consumer may infer readiness from the DB alone.
  await writeMetadata(ready, await readyBytes(options, true));
  await verifyReady(options, true);
}

/** Consumer admission requires independent expected inputs, not just self-consistent records. */
export async function verifyOfflineSessionBundle(supplied: Options): Promise<void> {
  // A present ready name may survive a failed/lost producer fsync response.
  // Admission re-establishes durability, not merely logical byte equality.
  await verifyReady(admittedOptions(supplied), true);
}

/** Load only a sealed inventory belonging to independently admitted preparation inputs. */
export async function loadOfflineSessionPublicationIntent(
  publicationDir: string,
  expected: Pick<
    OfflineSessionPublicationIntent,
    "agentId" | "inputDigest" | "preparationDigest"
  > & {
    members: Pick<
      OfflineSessionPublicationIntent["members"][number],
      "kind" | "sourcePath" | "targetPath"
    >[];
  },
  expectedInventorySha256: string,
): Promise<OfflineSessionPublicationIntent> {
  if (
    typeof expectedInventorySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedInventorySha256)
  ) {
    throw new Error("An independently approved inventory digest is required.");
  }
  const record = await readOfflineSessionRecord(path.join(publicationDir, "intent.json"));
  if (record.sha256 !== expectedInventorySha256) {
    throw new Error("Offline inventory digest differs from approved preparation.");
  }
  if (!record.value || typeof record.value !== "object" || Array.isArray(record.value)) {
    throw new Error("Offline publication intent is not a closed record.");
  }
  const { publicationDir: recordedDirectory, ...intent } = record.value as Record<string, unknown>;
  if (recordedDirectory !== publicationDir) {
    throw new Error("Offline publication directory changed.");
  }
  const admitted = admittedOptions({
    publicationDir,
    intent: intent as OfflineSessionPublicationIntent,
  });
  const { agentId, inputDigest, preparationDigest, members } = admitted.intent;
  if (
    JSON.stringify({
      agentId,
      inputDigest,
      preparationDigest,
      members: members.map(({ kind, sourcePath, targetPath }) => ({
        kind,
        sourcePath,
        targetPath,
      })),
    }) !== JSON.stringify(expected) ||
    content(intentBytes(admitted)).sha256 !== record.sha256
  ) {
    throw new Error("Offline publication intent differs from approved preparation.");
  }
  return admitted.intent;
}
