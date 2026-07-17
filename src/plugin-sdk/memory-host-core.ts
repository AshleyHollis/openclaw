/**
 * Public SDK facade for memory host runtime core and public artifact discovery.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { sha256Hex, sha256HexPrefix } from "../infra/crypto-digest.js";
import { withFileLock } from "../infra/file-lock.js";
import { FsSafeError, root as createFsSafeRoot } from "../infra/fs-safe.js";
import { syncDirectoryBestEffort } from "../infra/sqlite-snapshot.js";
import { listStoredMemoryHostEvents } from "../memory-host-sdk/event-store.js";
import type { MemoryPluginPublicArtifact } from "../plugins/memory-state.js";
import { KeyedAsyncQueue } from "./keyed-async-queue.js";
import { resolveMemoryDreamingWorkspaces } from "./memory-core-host-status.js";

const MEMORY_HOST_EVENTS_FILENAME = "memory-host-events.jsonl";
const MEMORY_HOST_EVENTS_OWNER_FILENAME = ".openclaw-memory-host-events-owner.json";
const MAX_MEMORY_HOST_PUBLIC_EXPORT_EVENTS = 1_000;
const MAX_MEMORY_HOST_PUBLIC_EXPORT_BYTES = 1024 * 1024;
const MEMORY_HOST_EVENT_EXPORT_LOCK_OPTIONS = {
  retries: { retries: 20, factor: 1.3, minTimeout: 25, maxTimeout: 250, randomize: true },
  stale: 30_000,
} as const;
const memoryHostEventExportQueue = new KeyedAsyncQueue();

function isMissingPathError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    (error instanceof FsSafeError && code === "not-found")
  );
}

function isRejectedWorkspaceArtifactPath(error: unknown): boolean {
  if (!(error instanceof FsSafeError)) {
    return false;
  }
  return (
    error.code === "hardlink" ||
    error.code === "not-file" ||
    error.code === "outside-workspace" ||
    error.code === "path-alias" ||
    error.code === "symlink"
  );
}

function isWorkspaceWriteUnavailable(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const code = (error as { code?: unknown }).code;
  if (
    code === "EACCES" ||
    code === "EEXIST" ||
    code === "ENOTDIR" ||
    code === "EPERM" ||
    code === "EROFS" ||
    (error instanceof FsSafeError && (code === "not-file" || code === "not-removable"))
  ) {
    return true;
  }
  if (error instanceof FsSafeError && error.category === "policy" && code !== "invalid-path") {
    return false;
  }
  return isWorkspaceWriteUnavailable((error as { cause?: unknown }).cause, seen);
}

async function resolveMemoryHostEventExportOwner(workspaceDir: string): Promise<{
  queueKey: string;
  lockTarget: string;
  relativePath: string;
  ownerRelativePath: string;
  stateHash: string;
  workspaceHash: string;
}> {
  const requestedStateDir = path.resolve(resolveStateDir());
  await fs.mkdir(requestedStateDir, { recursive: true, mode: 0o700 });
  const stateDir = await fs.realpath(requestedStateDir);
  const stateHash = sha256HexPrefix(stateDir, 32);
  const workspaceHash = sha256HexPrefix(path.resolve(workspaceDir), 32);
  const exportDirectory = path.posix.join("memory", "events", stateHash);
  return {
    queueKey: `${stateHash}\0${workspaceHash}`,
    lockTarget: path.join(stateDir, `.memory-host-events-export-${workspaceHash}`),
    relativePath: path.posix.join(exportDirectory, MEMORY_HOST_EVENTS_FILENAME),
    ownerRelativePath: path.posix.join(exportDirectory, MEMORY_HOST_EVENTS_OWNER_FILENAME),
    stateHash,
    workspaceHash,
  };
}

function memoryHostEventExportOwnerContent(
  owner: Awaited<ReturnType<typeof resolveMemoryHostEventExportOwner>>,
  content: { currentSha256?: string; pendingSha256?: string },
): string {
  return `${JSON.stringify({
    schemaVersion: 3,
    kind: "openclaw-memory-host-events-export",
    stateHash: owner.stateHash,
    workspaceHash: owner.workspaceHash,
    ...(content.currentSha256 ? { contentSha256: content.currentSha256 } : {}),
    ...(content.pendingSha256 ? { pendingContentSha256: content.pendingSha256 } : {}),
  })}\n`;
}

async function readMemoryHostEventExportOwnership(
  workspaceRoot: Awaited<ReturnType<typeof createFsSafeRoot>>,
  owner: Awaited<ReturnType<typeof resolveMemoryHostEventExportOwner>>,
): Promise<
  | { kind: "owned"; content: string; needsFinalize: boolean }
  | { kind: "missing" }
  | { kind: "orphan" }
  | { kind: "pending-missing" }
  | { kind: "foreign" }
> {
  const content = await workspaceRoot.readText(owner.ownerRelativePath).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return undefined;
    }
    if (isRejectedWorkspaceArtifactPath(error)) {
      return null;
    }
    throw error;
  });
  if (content === null) {
    return { kind: "foreign" };
  }
  if (content === undefined) {
    return { kind: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return { kind: "foreign" };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 3 ||
    (parsed as { kind?: unknown }).kind !== "openclaw-memory-host-events-export" ||
    (parsed as { stateHash?: unknown }).stateHash !== owner.stateHash ||
    (parsed as { workspaceHash?: unknown }).workspaceHash !== owner.workspaceHash ||
    ((parsed as { contentSha256?: unknown }).contentSha256 !== undefined &&
      typeof (parsed as { contentSha256?: unknown }).contentSha256 !== "string") ||
    ((parsed as { pendingContentSha256?: unknown }).pendingContentSha256 !== undefined &&
      typeof (parsed as { pendingContentSha256?: unknown }).pendingContentSha256 !== "string") ||
    ((parsed as { contentSha256?: unknown }).contentSha256 === undefined &&
      (parsed as { pendingContentSha256?: unknown }).pendingContentSha256 === undefined)
  ) {
    return { kind: "foreign" };
  }
  const exportContent = await workspaceRoot.readText(owner.relativePath).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return undefined;
    }
    if (isRejectedWorkspaceArtifactPath(error)) {
      return null;
    }
    throw error;
  });
  if (exportContent === null) {
    return { kind: "foreign" };
  }
  if (exportContent === undefined) {
    return typeof (parsed as { pendingContentSha256?: unknown }).pendingContentSha256 === "string"
      ? { kind: "pending-missing" }
      : { kind: "orphan" };
  }
  const exportSha256 = sha256Hex(exportContent);
  const currentSha256 = (parsed as { contentSha256?: string }).contentSha256;
  const pendingSha256 = (parsed as { pendingContentSha256?: string }).pendingContentSha256;
  return exportSha256 === currentSha256 || exportSha256 === pendingSha256
    ? {
        kind: "owned",
        content: exportContent,
        needsFinalize: exportSha256 !== currentSha256 || pendingSha256 !== undefined,
      }
    : { kind: "foreign" };
}

export {
  buildMemoryPromptSection as buildActiveMemoryPromptSection,
  clearMemoryPluginState,
  getMemoryCapabilityRegistration,
  listActiveMemoryPublicArtifacts,
  registerMemoryCapability,
  registerMemoryCorpusSupplement,
} from "../plugins/memory-state.js";
export type {
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPromptSectionBuilder,
} from "../plugins/memory-state.js";
export { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
export { resolveSessionAgentId } from "../agents/agent-scope.js";
export { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";

async function listMarkdownFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFilesRecursive(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function serializeMemoryHostEventExport(
  storedEvents: ReturnType<typeof listStoredMemoryHostEvents>,
): string {
  const lines: string[] = [];
  let sizeBytes = 0;
  for (const entry of storedEvents.toReversed()) {
    const line = JSON.stringify(entry.value.event);
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (sizeBytes + lineBytes > MAX_MEMORY_HOST_PUBLIC_EXPORT_BYTES) {
      break;
    }
    lines.push(line);
    sizeBytes += lineBytes;
  }
  return lines.toReversed().join("\n") + "\n";
}

async function materializeMemoryHostEventExport(params: {
  workspaceDir: string;
}): Promise<{ absolutePath: string; relativePath: string } | undefined> {
  const requestedWorkspace = path.resolve(params.workspaceDir);
  const workspace = await fs.stat(requestedWorkspace).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  });
  if (!workspace?.isDirectory()) {
    return undefined;
  }
  const workspaceRoot = await createFsSafeRoot(requestedWorkspace, {
    hardlinks: "reject",
    mkdir: true,
    mode: 0o600,
    symlinks: "reject",
  });
  const workspaceKey = workspaceRoot.rootReal;
  const owner = await resolveMemoryHostEventExportOwner(workspaceKey);
  // The queue handles re-entrant calls in this process; the sidecar lock makes
  // snapshot, cleanup, and replacement one ordered operation across processes.
  // State-qualified paths keep different profiles from replacing each other's export.
  return memoryHostEventExportQueue.enqueue(owner.queueKey, async () => {
    const absolutePath = path.join(workspaceKey, ...owner.relativePath.split("/"));
    return await withFileLock(owner.lockTarget, MEMORY_HOST_EVENT_EXPORT_LOCK_OPTIONS, async () => {
      const storedEvents = listStoredMemoryHostEvents({
        workspaceDir: workspaceKey,
        limit: MAX_MEMORY_HOST_PUBLIC_EXPORT_EVENTS,
      });
      let ownership = await readMemoryHostEventExportOwnership(workspaceRoot, owner);
      if (ownership.kind === "orphan") {
        try {
          await workspaceRoot.remove(owner.ownerRelativePath);
          await syncDirectoryBestEffort(path.dirname(absolutePath));
          ownership = { kind: "missing" };
        } catch (error) {
          if (isMissingPathError(error)) {
            ownership = { kind: "missing" };
          } else if (isWorkspaceWriteUnavailable(error)) {
            return undefined;
          } else {
            throw error;
          }
        }
      }
      if (storedEvents.length === 0) {
        if (ownership.kind === "pending-missing") {
          try {
            await workspaceRoot.remove(owner.ownerRelativePath);
            await syncDirectoryBestEffort(path.dirname(absolutePath));
          } catch (error) {
            if (!isMissingPathError(error) && !isWorkspaceWriteUnavailable(error)) {
              throw error;
            }
          }
          return undefined;
        }
        if (ownership.kind !== "owned") {
          return undefined;
        }
        try {
          // Revoke ownership before removing the export. A crash can leave a stale,
          // unowned artifact, but never a marker that authorizes a future user file.
          await workspaceRoot.remove(owner.ownerRelativePath);
          await syncDirectoryBestEffort(path.dirname(absolutePath));
          await workspaceRoot.remove(owner.relativePath);
        } catch (error) {
          if (isMissingPathError(error)) {
            return undefined;
          }
          if (isWorkspaceWriteUnavailable(error)) {
            return undefined;
          }
          throw error;
        }
        // Persist removal before releasing the cross-process export lock. Otherwise
        // a crash can resurrect a stale export after SQLite retention removed it.
        await syncDirectoryBestEffort(path.dirname(absolutePath));
        return undefined;
      }
      if (ownership.kind === "foreign") {
        return undefined;
      }
      const content = serializeMemoryHostEventExport(storedEvents);
      const contentSha256 = sha256Hex(content);
      if (ownership.kind === "missing") {
        const existing = await workspaceRoot
          .readText(owner.relativePath)
          .catch((error: unknown) => {
            if (isMissingPathError(error)) {
              return undefined;
            }
            if (isRejectedWorkspaceArtifactPath(error)) {
              return null;
            }
            throw error;
          });
        if (existing !== undefined) {
          return undefined;
        }
        try {
          // A content-specific pending hash makes marker-first publication
          // recoverable without authorizing replacement of a different later file.
          await workspaceRoot.create(
            owner.ownerRelativePath,
            memoryHostEventExportOwnerContent(owner, { pendingSha256: contentSha256 }),
            { mkdir: true, mode: 0o600 },
          );
          await syncDirectoryBestEffort(path.dirname(absolutePath));
          await workspaceRoot.create(owner.relativePath, content, { mkdir: true, mode: 0o600 });
          await syncDirectoryBestEffort(path.dirname(absolutePath));
          await workspaceRoot.write(
            owner.ownerRelativePath,
            memoryHostEventExportOwnerContent(owner, { currentSha256: contentSha256 }),
            { mkdir: true, mode: 0o600 },
          );
        } catch (error) {
          if (isWorkspaceWriteUnavailable(error)) {
            return undefined;
          }
          throw error;
        }
        await syncDirectoryBestEffort(path.dirname(absolutePath));
        return { absolutePath, relativePath: owner.relativePath };
      }
      if (ownership.kind === "pending-missing") {
        try {
          await workspaceRoot.write(
            owner.ownerRelativePath,
            memoryHostEventExportOwnerContent(owner, { pendingSha256: contentSha256 }),
            { mkdir: true, mode: 0o600 },
          );
          await syncDirectoryBestEffort(path.dirname(absolutePath));
          await workspaceRoot.create(owner.relativePath, content, { mkdir: true, mode: 0o600 });
          await syncDirectoryBestEffort(path.dirname(absolutePath));
          await workspaceRoot.write(
            owner.ownerRelativePath,
            memoryHostEventExportOwnerContent(owner, { currentSha256: contentSha256 }),
            { mkdir: true, mode: 0o600 },
          );
          await syncDirectoryBestEffort(path.dirname(absolutePath));
          return { absolutePath, relativePath: owner.relativePath };
        } catch (error) {
          if (isWorkspaceWriteUnavailable(error)) {
            return undefined;
          }
          throw error;
        }
      }
      // SQLite is authoritative. The owner hash proves the existing bytes are the
      // prior export before replacement and preserves stable mtimes when unchanged.
      if (ownership.content !== content) {
        try {
          await workspaceRoot.write(
            owner.ownerRelativePath,
            memoryHostEventExportOwnerContent(owner, {
              currentSha256: sha256Hex(ownership.content),
              pendingSha256: contentSha256,
            }),
            { mkdir: true, mode: 0o600 },
          );
          await syncDirectoryBestEffort(path.dirname(absolutePath));
          await workspaceRoot.write(owner.relativePath, content, {
            mkdir: true,
            mode: 0o600,
          });
          await syncDirectoryBestEffort(path.dirname(absolutePath));
          await workspaceRoot.write(
            owner.ownerRelativePath,
            memoryHostEventExportOwnerContent(owner, { currentSha256: contentSha256 }),
            { mkdir: true, mode: 0o600 },
          );
          await syncDirectoryBestEffort(path.dirname(absolutePath));
        } catch (error) {
          if (isWorkspaceWriteUnavailable(error)) {
            return undefined;
          }
          throw error;
        }
      } else if (ownership.needsFinalize) {
        try {
          await workspaceRoot.write(
            owner.ownerRelativePath,
            memoryHostEventExportOwnerContent(owner, { currentSha256: contentSha256 }),
            { mkdir: true, mode: 0o600 },
          );
          await syncDirectoryBestEffort(path.dirname(absolutePath));
        } catch (error) {
          if (isWorkspaceWriteUnavailable(error)) {
            return undefined;
          }
          throw error;
        }
      }
      return { absolutePath, relativePath: owner.relativePath };
    });
  });
}

/** Lists public memory artifacts for one workspace, including notes and event logs. */
async function listMemoryWorkspacePublicArtifacts(params: {
  workspaceDir: string;
  agentIds: string[];
}): Promise<MemoryPluginPublicArtifact[]> {
  const artifacts: MemoryPluginPublicArtifact[] = [];
  const workspaceEntries = new Set(
    (await fs.readdir(params.workspaceDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );

  if (workspaceEntries.has("MEMORY.md")) {
    const absolutePath = path.join(params.workspaceDir, "MEMORY.md");
    artifacts.push({
      kind: "memory-root",
      workspaceDir: params.workspaceDir,
      relativePath: "MEMORY.md",
      absolutePath,
      agentIds: [...params.agentIds],
      contentType: "markdown",
    });
  }

  const memoryDir = path.join(params.workspaceDir, "memory");
  for (const absolutePath of await listMarkdownFilesRecursive(memoryDir)) {
    const relativePath = path.relative(params.workspaceDir, absolutePath).replace(/\\/g, "/");
    artifacts.push({
      kind: relativePath.startsWith("memory/dreaming/") ? "dream-report" : "daily-note",
      workspaceDir: params.workspaceDir,
      relativePath,
      absolutePath,
      agentIds: [...params.agentIds],
      contentType: "markdown",
    });
  }

  const eventExport = await materializeMemoryHostEventExport({
    workspaceDir: params.workspaceDir,
  });
  if (eventExport) {
    artifacts.push({
      kind: "event-log",
      workspaceDir: params.workspaceDir,
      relativePath: eventExport.relativePath,
      absolutePath: eventExport.absolutePath,
      agentIds: [...params.agentIds],
      contentType: "json",
    });
  }

  const deduped = new Map<string, MemoryPluginPublicArtifact>();
  for (const artifact of artifacts) {
    deduped.set(`${artifact.workspaceDir}\0${artifact.relativePath}\0${artifact.kind}`, artifact);
  }
  return [...deduped.values()];
}

/** Lists public memory artifacts across all configured memory workspaces. */
export async function listMemoryHostPublicArtifacts(params: {
  cfg: OpenClawConfig;
}): Promise<MemoryPluginPublicArtifact[]> {
  const workspaces = resolveMemoryDreamingWorkspaces(params.cfg);
  const artifacts: MemoryPluginPublicArtifact[] = [];
  for (const workspace of workspaces) {
    artifacts.push(
      ...(await listMemoryWorkspacePublicArtifacts({
        workspaceDir: workspace.workspaceDir,
        agentIds: workspace.agentIds,
      })),
    );
  }
  return artifacts;
}
