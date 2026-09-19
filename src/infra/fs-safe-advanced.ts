// Provides stricter filesystem helpers for canonical path and symlink-sensitive operations.
import "./fs-safe-defaults.js";
import { stageFileInDirectory } from "@openclaw/fs-safe/advanced";

/**
 * Restricted plugin-facing durable publication. The fs-safe staging primitive
 * requires its native helper without changing OpenClaw's process-wide mode.
 */
export function stageDurableFileInDirectory(
  options: Pick<Parameters<typeof stageFileInDirectory>[0], "directory" | "content" | "mode">,
) {
  return stageFileInDirectory(options);
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
