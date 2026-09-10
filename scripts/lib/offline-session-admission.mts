import fs from "node:fs/promises";
import path from "node:path";
import { isSessionArchiveArtifactName } from "../../src/config/sessions/artifacts.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../../src/config/sessions/session-accessor.sqlite-scope.js";
import { hasErrnoCode } from "../../src/infra/errno.js";
import { normalizeWindowsPathForComparison } from "../../src/infra/path-guards.js";
import { normalizeAgentId } from "../../src/routing/session-key.js";
import {
  assertUnaliasedOfflinePath,
  readOfflineSessionRecord,
  verifyOfflineSessionFile,
  type OfflineSessionFileContent,
} from "./offline-session-artifacts.mts";

const MAX_OFFLINE_ARCHIVE_INVENTORY_BYTES = 1024 * 1024 * 1024;
const SIDECARS = ["-journal", "-shm", "-wal"] as const;
export type OfflineSessionApproval = {
  schemaVersion: 1;
  purpose: "command-center-offline-session-preparation";
  agentId: string;
  sourcePath: string;
  targetPath: string;
  privateStateDir: string;
  publicationDir: string;
  maxTotalArchiveBytes: number;
  /** The trusted launcher binds this to its pinned image and reviewed helper closure. */
  preparationDigest: string;
  database: OfflineSessionFileContent;
  sidecars: (OfflineSessionFileContent & { suffix: (typeof SIDECARS)[number] })[];
  archives: (OfflineSessionFileContent & { name: string })[];
};

export function assertOfflineRecordKeys(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join("\n") !== keys.toSorted().join("\n")
  ) {
    throw new Error("Offline admission requires a closed record.");
  }
}

function fileContent(value: unknown, extra: string[] = []): void {
  assertOfflineRecordKeys(value, ["sha256", "sizeBytes", ...extra]);
  if (
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) < 0
  ) {
    throw new Error("Offline admission requires exact bounded file content.");
  }
}

/** Include native-derived files and the lock sidecar, not just CLI arguments. */
function preparationPaths(
  approval: OfflineSessionApproval,
  approvalManifestPath?: string,
): string[] {
  const sourceDir = resolveSqliteTranscriptArchiveDirectory({
    agentId: approval.agentId,
    path: approval.sourcePath,
  });
  const targetDir = resolveSqliteTranscriptArchiveDirectory({
    agentId: approval.agentId,
    path: approval.targetPath,
  });
  return [
    approval.sourcePath,
    approval.targetPath,
    approval.privateStateDir,
    approval.publicationDir,
    `${approval.publicationDir}.lock`,
    ...SIDECARS.flatMap((suffix) => [
      `${approval.sourcePath}${suffix}`,
      `${approval.targetPath}${suffix}`,
    ]),
    ...approval.archives.flatMap(({ name }) => [
      path.join(sourceDir, name),
      path.join(targetDir, name),
    ]),
    ...(approvalManifestPath === undefined ? [] : [approvalManifestPath]),
  ];
}

function assertIndependentPreparationPaths(
  approval: OfflineSessionApproval,
  approvalManifestPath?: string,
): void {
  const paths = preparationPaths(approval, approvalManifestPath).map((item) =>
    process.platform === "win32" ? normalizeWindowsPathForComparison(item) : item,
  );
  const protectedPaths = new Set(paths);
  if (protectedPaths.size !== paths.length) {
    throw new Error("Offline preparation paths must be independent.");
  }
  // Walking parents is bounded by path depth, rather than comparing every archive pair.
  for (const item of paths) {
    let parent = path.dirname(item);
    while (parent !== item) {
      if (protectedPaths.has(parent)) {
        throw new Error("Offline preparation paths must be independent.");
      }
      const next = path.dirname(parent);
      if (next === parent) {
        break;
      }
      parent = next;
    }
  }
}

function admitOfflineSessionApproval(value: unknown): OfflineSessionApproval {
  assertOfflineRecordKeys(value, [
    "schemaVersion",
    "purpose",
    "agentId",
    "sourcePath",
    "targetPath",
    "privateStateDir",
    "publicationDir",
    "maxTotalArchiveBytes",
    "preparationDigest",
    "database",
    "sidecars",
    "archives",
  ]);
  const paths = [value.sourcePath, value.targetPath, value.privateStateDir, value.publicationDir];
  if (
    value.schemaVersion !== 1 ||
    value.purpose !== "command-center-offline-session-preparation" ||
    typeof value.agentId !== "string" ||
    !value.agentId ||
    normalizeAgentId(value.agentId) !== value.agentId ||
    paths.some((p) => typeof p !== "string" || !path.isAbsolute(p) || path.resolve(p) !== p) ||
    typeof value.preparationDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.preparationDigest) ||
    !Number.isSafeInteger(value.maxTotalArchiveBytes) ||
    (value.maxTotalArchiveBytes as number) < 1 ||
    (value.maxTotalArchiveBytes as number) > MAX_OFFLINE_ARCHIVE_INVENTORY_BYTES ||
    !Array.isArray(value.archives) ||
    value.archives.length > 4096 ||
    !Array.isArray(value.sidecars) ||
    value.sidecars.length > 3
  ) {
    throw new Error("Offline approval has invalid identities, paths or limits.");
  }
  fileContent(value.database);
  let previous = "";
  for (const sidecar of value.sidecars) {
    fileContent(sidecar, ["suffix"]);
    if (!SIDECARS.includes(sidecar.suffix) || sidecar.suffix <= previous) {
      throw new Error("Invalid SQLite companion inventory.");
    }
    previous = sidecar.suffix;
  }
  previous = "";
  let total = 0;
  for (const archive of value.archives) {
    fileContent(archive, ["name"]);
    if (
      typeof archive.name !== "string" ||
      archive.name !== path.basename(archive.name) ||
      !archive.name.includes(".jsonl.") ||
      !isSessionArchiveArtifactName(archive.name) ||
      archive.name <= previous
    ) {
      throw new Error("Invalid exact archive inventory.");
    }
    total += archive.sizeBytes;
    if (total > (value.maxTotalArchiveBytes as number)) {
      throw new Error("Approved archive inventory exceeds its limit.");
    }
    previous = archive.name;
  }
  const approval = structuredClone(value) as OfflineSessionApproval;
  assertIndependentPreparationPaths(approval);
  return approval;
}

export async function loadOfflineSessionApproval(
  filePath: string,
  expectedSha256: string,
): Promise<OfflineSessionApproval> {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) {
    throw new Error("Offline approval requires an exact absolute path.");
  }
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("An independently pinned approval digest is required.");
  }
  const record = await readOfflineSessionRecord(filePath);
  if (record.sha256 !== expectedSha256) {
    throw new Error("Offline approval digest mismatch.");
  }
  const approval = admitOfflineSessionApproval(record.value);
  assertIndependentPreparationPaths(approval, filePath);
  for (const candidate of preparationPaths(approval, filePath)) {
    await assertUnaliasedOfflinePath(candidate);
  }
  return approval;
}

async function listOfflineSessionArchives(
  approval: Pick<OfflineSessionApproval, "agentId" | "sourcePath">,
): Promise<string[]> {
  const directory = resolveSqliteTranscriptArchiveDirectory({
    agentId: approval.agentId,
    path: approval.sourcePath,
  });
  const entries = await fs.readdir(directory).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  });
  return entries
    .filter((name) => name.includes(".jsonl.") && isSessionArchiveArtifactName(name))
    .toSorted();
}

export async function verifyOfflineSessionSources(approval: OfflineSessionApproval): Promise<void> {
  if (
    JSON.stringify(await listOfflineSessionArchives(approval)) !==
    JSON.stringify(approval.archives.map((item) => item.name))
  ) {
    throw new Error("Original archive inventory differs from approval.");
  }
  const present: string[] = [];
  for (const suffix of SIDECARS) {
    try {
      await fs.lstat(`${approval.sourcePath}${suffix}`);
      present.push(suffix);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  if (JSON.stringify(present) !== JSON.stringify(approval.sidecars.map((item) => item.suffix))) {
    throw new Error("Original SQLite companion inventory differs from approval.");
  }
  await verifyOfflineSessionFile(approval.sourcePath, approval.database);
  for (const item of approval.sidecars) {
    await verifyOfflineSessionFile(`${approval.sourcePath}${item.suffix}`, item);
  }
  const archiveDir = resolveSqliteTranscriptArchiveDirectory({
    agentId: approval.agentId,
    path: approval.sourcePath,
  });
  for (const item of approval.archives) {
    await verifyOfflineSessionFile(path.join(archiveDir, item.name), item);
  }
}
