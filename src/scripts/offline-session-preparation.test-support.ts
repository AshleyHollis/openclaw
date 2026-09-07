import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OfflineSessionApproval } from "../../scripts/lib/offline-session-admission.mts";
import { isSessionArchiveArtifactName } from "../config/sessions/artifacts.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";

/** Synthetic fixture approval; never used to approve real operator data. */
export async function createFixturePreparationApproval(options: {
  sourcePath: string;
  targetPath: string;
  agentId: string;
  privateStateDir: string;
  maxTotalArchiveBytes?: number;
}) {
  const content = async (filePath: string) => {
    const bytes = await fs.readFile(filePath);
    return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
  };
  const publicationDir = `${options.privateStateDir}-publication`;
  const approval: OfflineSessionApproval = {
    schemaVersion: 1,
    purpose: "command-center-offline-session-preparation",
    ...options,
    publicationDir,
    maxTotalArchiveBytes: options.maxTotalArchiveBytes ?? 1024 * 1024 * 1024,
    preparationDigest: "d".repeat(64),
    database: await content(options.sourcePath),
    sidecars: [],
    archives: [],
  };
  for (const suffix of ["-journal", "-shm", "-wal"] as const) {
    try {
      await fs.lstat(`${options.sourcePath}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    approval.sidecars.push({ suffix, ...(await content(`${options.sourcePath}${suffix}`)) });
  }
  const archiveDir = resolveSqliteTranscriptArchiveDirectory({
    agentId: options.agentId,
    path: options.sourcePath,
  });
  const entries = await fs.readdir(archiveDir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  });
  for (const name of entries
    .filter((entry) => entry.includes(".jsonl.") && isSessionArchiveArtifactName(entry))
    .toSorted()) {
    approval.archives.push({ name, ...(await content(path.join(archiveDir, name))) });
  }
  const approvalManifestPath = `${options.privateStateDir}-approval.json`;
  const bytes = Buffer.from(`${JSON.stringify(approval)}\n`);
  await fs.writeFile(approvalManifestPath, bytes, { flag: "wx", mode: 0o600 });
  return {
    publicationDir,
    approvalManifestPath,
    approvalManifestSha256: createHash("sha256").update(bytes).digest("hex"),
    approval,
  };
}
