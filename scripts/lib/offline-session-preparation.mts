import { closeSync, fstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { withDoctorSqliteMaintenanceLock } from "../../src/commands/doctor-sqlite-maintenance-lock.js";
import { SESSION_ARCHIVE_ZSTD_SUFFIX } from "../../src/config/sessions/archive-compression.js";
import { isSessionArchiveArtifactName } from "../../src/config/sessions/artifacts.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../../src/config/sessions/session-accessor.sqlite-scope.js";
import { openRootFile, readFileDescriptorBoundedSync } from "../../src/infra/boundary-file-read.js";
import {
  ensureDurableDirectory,
  pinDirectory,
  requireDirectorySync,
  syncDirectory,
} from "../../src/infra/directory-durability.js";
import { hasErrnoCode } from "../../src/infra/errno.js";
import { withFileLock } from "../../src/infra/file-lock.js";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import { isPathInside } from "../../src/infra/path-guards.js";
import { createPrivateSqliteDirectory } from "../../src/infra/sqlite-private-directory.js";
import { createVerifiedSqliteSnapshot } from "../../src/infra/sqlite-snapshot.js";
import { migrateLegacyMediaPersistence } from "../../src/infra/state-migrations.media-persistence.js";
import { normalizeAgentId } from "../../src/routing/session-key.js";
import { closeOpenClawAgentDatabasesAsync } from "../../src/state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import {
  assertOfflineRecordKeys,
  loadOfflineSessionApproval,
  verifyOfflineSessionSources,
  type OfflineSessionApproval,
} from "./offline-session-admission.mts";
import {
  captureOfflineSessionArchive,
  MAX_OFFLINE_ARCHIVE_BYTES,
} from "./offline-session-archives.mts";
import {
  assertUnaliasedOfflinePath,
  copyOfflineSessionArtifact,
  inspectOfflineSessionFile,
  readOfflineSessionRecord,
  writeOfflineSessionRecord,
} from "./offline-session-artifacts.mts";
import { captureOfflineSessionContent } from "./offline-session-content.mts";
import {
  loadOfflineSessionPublicationIntent,
  publishOfflineSessionBundle,
  type OfflineSessionPublicationIntent,
} from "./offline-session-publication.mts";
import {
  assertOfflineSessionOriginalSchema,
  createOfflineSessionSnapshot,
} from "./offline-session-snapshot.mts";

const MAX_ARCHIVE_FILES = 4096;
const MAX_TOTAL_ARCHIVE_BYTES = 1024 * 1024 * 1024;

async function openAdmittedArchive(
  archiveDir: string,
  archivePath: string,
  allowPublishedHardlink = false,
) {
  const opened = await openRootFile({
    rootPath: archiveDir,
    absolutePath: archivePath,
    boundaryLabel: "offline transcript archives",
    rejectHardlinks: !allowPublishedHardlink,
    rejectSymlinks: true,
    maxBytes: MAX_OFFLINE_ARCHIVE_BYTES,
  });
  if (!opened.ok) {
    throw new Error("Offline archive admission refused an unsafe or unreadable source.");
  }
  return opened;
}

async function readAdmittedArchive(
  archiveDir: string,
  archivePath: string,
  allowPublishedHardlink = false,
) {
  const opened = await openAdmittedArchive(archiveDir, archivePath, allowPublishedHardlink);
  try {
    const bytes = readFileDescriptorBoundedSync(opened.fd, MAX_OFFLINE_ARCHIVE_BYTES);
    const after = fstatSync(opened.fd);
    if (
      after.size !== opened.stat.size ||
      after.mtimeMs !== opened.stat.mtimeMs ||
      after.ctimeMs !== opened.stat.ctimeMs ||
      after.nlink !== opened.stat.nlink
    ) {
      throw new Error("Offline archive admission detected a changing source.");
    }
    return bytes;
  } finally {
    closeSync(opened.fd);
  }
}

type PreparationOptions = {
  sourcePath: string;
  targetPath: string;
  agentId: string;
  privateStateDir: string;
  /** May tighten, never increase, the fixed production inventory limit. */
  maxTotalArchiveBytes?: number;
  publicationDir: string;
  approvalManifestPath: string;
  approvalManifestSha256: string;
};
type PreparationResult = {
  schemaVersion: 19;
  preparationRecordSha256: string;
  publicationIntentSha256: string;
};
type PublicationResult = { schemaVersion: 19; cleanup: "removed" | "retained" };
type PublicationApproval = Pick<
  PreparationResult,
  "preparationRecordSha256" | "publicationIntentSha256"
>;

function memberPaths(approval: OfflineSessionApproval) {
  const copiedPath = path.join(
    approval.privateStateDir,
    "agents",
    approval.agentId,
    "agent",
    "openclaw-agent.sqlite",
  );
  const sourceDir = resolveSqliteTranscriptArchiveDirectory({
    agentId: approval.agentId,
    path: copiedPath,
  });
  const targetDir = resolveSqliteTranscriptArchiveDirectory({
    agentId: approval.agentId,
    path: approval.targetPath,
  });
  return [
    {
      kind: "database" as const,
      sourcePath: path.join(approval.privateStateDir, "prepared-session.sqlite"),
      targetPath: approval.targetPath,
    },
    ...approval.archives.map(({ name }) => ({
      kind: "archive" as const,
      sourcePath: path.join(sourceDir, name),
      targetPath: path.join(targetDir, name),
    })),
  ];
}

async function cleanupPreparation(
  privateStateDir: string,
  expected: { dev: string; ino: string },
): Promise<PublicationResult> {
  try {
    const current = await fs.lstat(privateStateDir, { bigint: true });
    if (
      !current.isDirectory() ||
      String(current.dev) !== expected.dev ||
      String(current.ino) !== expected.ino ||
      (await fs.realpath(privateStateDir)) !== privateStateDir
    ) {
      return { schemaVersion: 19, cleanup: "retained" };
    }
    await fs.rm(privateStateDir, { recursive: true });
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      return { schemaVersion: 19, cleanup: "retained" };
    }
  }
  try {
    // Re-establish the unlink even when retry observes the scratch name absent.
    requireDirectorySync(
      await syncDirectory(path.dirname(privateStateDir)),
      "Offline scratch removal",
    );
  } catch {
    return { schemaVersion: 19, cleanup: "retained" };
  }
  return { schemaVersion: 19, cleanup: "removed" };
}

async function publishApprovedPreparation(
  approval: OfflineSessionApproval,
  approvalDigest: string,
  publicationApproval: PublicationApproval,
): Promise<PublicationResult> {
  const recordPath = path.join(approval.publicationDir, "preparation.json");
  if (!/^[a-f0-9]{64}$/.test(publicationApproval.preparationRecordSha256)) {
    throw new Error("An independently approved preparation digest is required.");
  }
  const record = await readOfflineSessionRecord(recordPath);
  if (record.sha256 !== publicationApproval.preparationRecordSha256) {
    throw new Error("Offline preparation digest differs from independent approval.");
  }
  assertOfflineRecordKeys(record.value, [
    "schemaVersion",
    "approvalDigest",
    "selectedSnapshot",
    "scratchIdentity",
  ]);
  const saved = record.value;
  assertOfflineRecordKeys(saved.selectedSnapshot, ["sha256", "sizeBytes"]);
  assertOfflineRecordKeys(saved.scratchIdentity, ["dev", "ino"]);
  if (
    saved.schemaVersion !== 1 ||
    saved.approvalDigest !== approvalDigest ||
    typeof saved.selectedSnapshot.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(saved.selectedSnapshot.sha256) ||
    !Number.isSafeInteger(saved.selectedSnapshot.sizeBytes) ||
    (saved.selectedSnapshot.sizeBytes as number) < 1 ||
    typeof saved.scratchIdentity.dev !== "string" ||
    !/^\d+$/.test(saved.scratchIdentity.dev) ||
    typeof saved.scratchIdentity.ino !== "string" ||
    !/^\d+$/.test(saved.scratchIdentity.ino)
  ) {
    throw new Error("Offline preparation record differs from approved input.");
  }
  const bundleDir = path.join(approval.publicationDir, "bundle");
  // Absence of a sealed intent does not authorize replay of partly migrated state.
  const intent = await loadOfflineSessionPublicationIntent(
    path.join(approval.publicationDir, "proposal"),
    {
      agentId: approval.agentId,
      inputDigest: record.sha256,
      preparationDigest: approval.preparationDigest,
      members: memberPaths(approval),
    },
    publicationApproval.publicationIntentSha256,
  );
  if (approval.archives.length > 0) {
    const targetArchiveDir = resolveSqliteTranscriptArchiveDirectory({
      agentId: approval.agentId,
      path: approval.targetPath,
    });
    await assertUnaliasedOfflinePath(targetArchiveDir);
    // The DB destination parent must exist. The native archive layout is either
    // that directory or its sibling, so only one new directory edge is possible.
    const databaseParent = await pinDirectory(path.dirname(approval.targetPath));
    try {
      const directory = await ensureDurableDirectory({
        directoryPath: targetArchiveDir,
        mode: 0o700,
      });
      requireDirectorySync(directory.parentSync, "Offline archive directory");
      // A previous mkdir may have survived a lost sync response; existence alone
      // does not establish durability on retry.
      requireDirectorySync(
        await syncDirectory(path.dirname(targetArchiveDir)),
        "Offline archive directory",
      );
      await databaseParent.assertCurrent();
    } finally {
      await databaseParent.close();
    }
    await assertUnaliasedOfflinePath(targetArchiveDir);
  }
  await publishOfflineSessionBundle({ publicationDir: bundleDir, intent });
  return await cleanupPreparation(approval.privateStateDir, {
    dev: saved.scratchIdentity.dev,
    ino: saved.scratchIdentity.ino,
  });
}

async function withApprovedPreparation<T>(
  options: PreparationOptions,
  run: (approval: OfflineSessionApproval, approvalDigest: string) => Promise<T>,
): Promise<T> {
  const supplied = structuredClone(options);
  const approval = await loadOfflineSessionApproval(
    supplied.approvalManifestPath,
    supplied.approvalManifestSha256,
  );
  for (const key of [
    "sourcePath",
    "targetPath",
    "agentId",
    "privateStateDir",
    "publicationDir",
  ] as const) {
    if (supplied[key] !== approval[key]) {
      throw new Error("Offline preparation arguments differ from approval.");
    }
  }
  if (
    (supplied.maxTotalArchiveBytes ?? approval.maxTotalArchiveBytes) !==
      approval.maxTotalArchiveBytes ||
    isPathInside(approval.privateStateDir, supplied.approvalManifestPath)
  ) {
    throw new Error("Offline preparation limits or approval location differ.");
  }
  const parent = await pinDirectory(path.dirname(approval.publicationDir));
  try {
    if (parent.receipt.path !== parent.receipt.realPath) {
      throw new Error("Offline preparation parent is aliased.");
    }
    await parent.assertCurrent();
    return await withFileLock(
      approval.publicationDir,
      {
        retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
        stale: 30 * 60 * 1000,
        staleRecovery: "fail-closed",
      },
      async () => {
        await parent.assertCurrent();
        return await run(approval, supplied.approvalManifestSha256);
      },
    );
  } finally {
    await parent.close();
  }
}

/** Prepare only. The parent must observe successful process closure before sealing these digests. */
export async function prepareOfflineSessionSnapshot(
  options: PreparationOptions,
): Promise<PreparationResult> {
  return await withApprovedPreparation(options, prepareAdmittedOfflineSessionSnapshot);
}

/** Publication/recovery requires the parent's durable approval, never reconstructed child records. */
export async function publishPreparedOfflineSessionSnapshot(
  options: PreparationOptions & PublicationApproval,
): Promise<PublicationResult> {
  const publicationApproval = {
    preparationRecordSha256: options.preparationRecordSha256,
    publicationIntentSha256: options.publicationIntentSha256,
  };
  return await withApprovedPreparation(options, (approval, digest) =>
    publishApprovedPreparation(approval, digest, publicationApproval),
  );
}

async function prepareAdmittedOfflineSessionSnapshot(
  options: OfflineSessionApproval,
  approvalDigest: string,
): Promise<PreparationResult> {
  const { sourcePath, targetPath, agentId, privateStateDir, maxTotalArchiveBytes } = options;
  await verifyOfflineSessionSources(options);
  if (
    !Number.isSafeInteger(maxTotalArchiveBytes) ||
    maxTotalArchiveBytes < 1 ||
    maxTotalArchiveBytes > MAX_TOTAL_ARCHIVE_BYTES
  ) {
    throw new Error("Offline preparation requires a positive bounded archive inventory limit.");
  }
  if (
    [sourcePath, targetPath, privateStateDir].some(
      (value) => !path.isAbsolute(value) || path.resolve(value) !== value,
    ) ||
    normalizeAgentId(agentId) !== agentId ||
    targetPath === privateStateDir ||
    isPathInside(privateStateDir, targetPath)
  ) {
    throw new Error(
      "Offline preparation requires exact independent absolute paths and agent identity.",
    );
  }
  const archiveDir = resolveSqliteTranscriptArchiveDirectory({ agentId, path: sourcePath });
  const entries = await fs.readdir(archiveDir).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  });
  // The migration's ordinary discovery skips non-files. Preparation must not
  // silently lose a matching archive because it is an alias or unsafe entry.
  const sourceArchives = entries
    .filter((name) => name.includes(".jsonl.") && isSessionArchiveArtifactName(name))
    .toSorted()
    .map((name) => path.join(archiveDir, name));
  if (sourceArchives.length > MAX_ARCHIVE_FILES) {
    throw new Error("Offline archive inventory exceeds the admitted file-count limit.");
  }
  for (const archive of sourceArchives) {
    const opened = await openAdmittedArchive(archiveDir, archive);
    closeSync(opened.fd);
  }
  // A fresh root prevents native registry/disk discovery from finding unrelated agents.
  await createPrivateSqliteDirectory(privateStateDir);
  const rootIdentity = await fs.lstat(privateStateDir, { bigint: true });
  const agentDirectory = path.join(privateStateDir, "agents", agentId, "agent");
  await fs.mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  const copiedPath = path.join(agentDirectory, "openclaw-agent.sqlite");
  const copiedArchiveDir = resolveSqliteTranscriptArchiveDirectory({ agentId, path: copiedPath });
  await fs.mkdir(copiedArchiveDir, { recursive: true, mode: 0o700 });
  const archiveCopies: string[] = [];
  const archiveAccounting = new Map<string, ReturnType<typeof captureOfflineSessionArchive>>();
  let totalOriginalBytes = 0;
  let totalPreparedBytes = 0;
  let totalStoredBytes = 0;
  for (const sourceArchive of sourceArchives) {
    const copiedArchive = path.join(copiedArchiveDir, path.basename(sourceArchive));
    const bytes = await readAdmittedArchive(archiveDir, sourceArchive);
    totalStoredBytes += bytes.byteLength;
    if (totalStoredBytes > maxTotalArchiveBytes) {
      throw new Error("Offline archive inventory exceeds the aggregate stored-byte limit.");
    }
    const accounting = captureOfflineSessionArchive(bytes, {
      compressed: sourceArchive.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX),
    });
    const approvedArchive = options.archives.find(
      (item) => item.name === path.basename(sourceArchive),
    );
    if (
      !approvedArchive ||
      approvedArchive.sha256 !== accounting.sourceSha256 ||
      approvedArchive.sizeBytes !== bytes.length
    ) {
      throw new Error("Copied archive bytes differ from the approved original.");
    }
    totalOriginalBytes += accounting.decodedBytes;
    totalPreparedBytes += accounting.preparedDecodedBytes;
    if (Math.max(totalOriginalBytes, totalPreparedBytes) > maxTotalArchiveBytes) {
      throw new Error("Offline archive inventory exceeds the aggregate decoded-byte limit.");
    }
    await fs.writeFile(copiedArchive, bytes, { flag: "wx", mode: 0o600 });
    if (!(await readAdmittedArchive(copiedArchiveDir, copiedArchive)).equals(bytes)) {
      throw new Error("Offline archive copy verification failed.");
    }
    archiveAccounting.set(copiedArchive, accounting);
    archiveCopies.push(copiedArchive);
  }
  const env = {
    OPENCLAW_STATE_DIR: privateStateDir,
    OPENCLAW_HOME: privateStateDir,
    OPENCLAW_CONFIG_PATH: path.join(privateStateDir, "openclaw.json"),
  };
  // SQLite may update SHM or recover a journal while opening its source. Only
  // this approved private raw copy is ever passed to the native snapshot owner.
  const rawDir = path.join(privateStateDir, "original-input");
  await fs.mkdir(rawDir, { mode: 0o700 });
  const rawPath = path.join(rawDir, "database.sqlite");
  await copyOfflineSessionArtifact(sourcePath, rawPath, options.database);
  for (const item of options.sidecars) {
    await copyOfflineSessionArtifact(
      `${sourcePath}${item.suffix}`,
      `${rawPath}${item.suffix}`,
      item,
    );
  }
  await verifyOfflineSessionSources(options);
  await createVerifiedSqliteSnapshot({
    sourcePath: rawPath,
    targetPath: copiedPath,
    requireNonEmptySource: true,
    validate(database) {
      assertOfflineSessionOriginalSchema(database, agentId);
    },
  });
  const selectedSnapshot = (await inspectOfflineSessionFile(copiedPath, Number.MAX_SAFE_INTEGER))
    .content;
  // Approval already binds the original raw hashes; this is a distinct selected SQLite snapshot.
  await createPrivateSqliteDirectory(options.publicationDir);
  const preparationRecordPath = path.join(options.publicationDir, "preparation.json");
  await writeOfflineSessionRecord(preparationRecordPath, {
    schemaVersion: 1,
    approvalDigest,
    selectedSnapshot,
    scratchIdentity: { dev: String(rootIdentity.dev), ino: String(rootIdentity.ino) },
  });
  const inputDigest = (await readOfflineSessionRecord(preparationRecordPath)).sha256;
  let intent: OfflineSessionPublicationIntent | undefined;
  await withDoctorSqliteMaintenanceLock({
    env,
    operation: "offline Session preparation",
    protectedPaths: [copiedPath, `${copiedPath}-wal`, `${copiedPath}-shm`, ...archiveCopies],
    async run(authority) {
      const failures: unknown[] = [];
      try {
        authority.assertCurrent();
        const originalCopy = openNodeSqliteDatabase(copiedPath, { readOnly: true });
        let contentAccounting: ReturnType<typeof captureOfflineSessionContent>;
        try {
          contentAccounting = captureOfflineSessionContent(originalCopy);
        } finally {
          originalCopy.close();
        }
        openOpenClawStateDatabase({ env });
        const result = await migrateLegacyMediaPersistence({
          env,
          configuredAgentDatabaseTargets: [{ agentId, path: copiedPath }],
        });
        if (result.warnings.length > 0) {
          throw new Error(
            "Native offline migration reported warnings; retain private preparation.",
          );
        }
        authority.assertCurrent();
        const migratedCopy = openNodeSqliteDatabase(copiedPath, { readOnly: true });
        try {
          contentAccounting.assertPrepared(migratedCopy);
        } finally {
          migratedCopy.close();
        }
        for (const [archive, accounting] of archiveAccounting) {
          accounting.assertPrepared(await readAdmittedArchive(copiedArchiveDir, archive));
        }
        // This validates the actual resulting owner/schema/integrity, not only warnings.
        const paths = memberPaths(options);
        await createOfflineSessionSnapshot({
          sourcePath: copiedPath,
          targetPath: paths[0]!.sourcePath,
          agentId,
        });
        const members: OfflineSessionPublicationIntent["members"] = [];
        for (const item of paths) {
          const inspected = await inspectOfflineSessionFile(
            item.sourcePath,
            Number.MAX_SAFE_INTEGER,
          );
          members.push({
            ...item,
            ...inspected.content,
            dev: String(inspected.identity.dev),
            ino: String(inspected.identity.ino),
          });
        }
        authority.assertCurrent();
        intent = {
          schemaVersion: 1,
          agentId,
          inputDigest,
          preparationDigest: options.preparationDigest,
          members,
        };
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await closeOpenClawAgentDatabasesAsync(privateStateDir);
        } catch (error) {
          failures.push(error);
        }
        try {
          closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(env));
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Offline preparation failed; retain private state.");
      }
    },
  });
  if (!intent) {
    throw new Error("Offline preparation did not produce an inventory.");
  }
  // Record the proposal only after every database and maintenance lease has closed.
  // No target publication or scratch cleanup occurs in this process.
  const proposalDir = path.join(options.publicationDir, "proposal");
  await createPrivateSqliteDirectory(proposalDir);
  const intentPath = path.join(proposalDir, "intent.json");
  await writeOfflineSessionRecord(intentPath, {
    publicationDir: proposalDir,
    ...intent,
  });
  return {
    schemaVersion: 19,
    preparationRecordSha256: inputDigest,
    publicationIntentSha256: (await readOfflineSessionRecord(intentPath)).sha256,
  };
}
