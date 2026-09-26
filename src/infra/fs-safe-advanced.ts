// Provides stricter filesystem helpers for canonical path and symlink-sensitive operations.
import "./fs-safe-defaults.js";
import { stageFileInDirectory } from "@openclaw/fs-safe/advanced";
import { publishDirectoryNoReplace } from "@openclaw/fs-safe/atomic";

/**
 * Restricted plugin-facing durable publication. The fs-safe staging primitive
 * requires its native helper without changing OpenClaw's process-wide mode.
 */
export function stageDurableFileInDirectory(
  options: Pick<Parameters<typeof stageFileInDirectory>[0], "directory" | "content" | "mode">,
) {
  return stageFileInDirectory(options);
}

/** Publish an already identified sibling directory without replacing a target. */
export function publishDurableDirectoryNoReplace(
  options: Parameters<typeof publishDirectoryNoReplace>[0],
) {
  return publishDirectoryNoReplace(options);
}

// Advanced fs-safe helpers for symlink, hardlink, and sibling-temp protections.
export {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  buildRandomTempFilePath,
  probePathCaseInsensitiveSync,
  readFileHandleBounded,
  resolvePathPrefixSync,
  type FileIdentityStat,
  sameFileIdentity,
  sanitizeUntrustedFileName,
  tempFile,
} from "@openclaw/fs-safe/advanced";
export { readSecretFile } from "@openclaw/fs-safe/secret";
