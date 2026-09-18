// Provides stricter filesystem helpers for canonical path and symlink-sensitive operations.
import "./fs-safe-defaults.js";
import { stageFileInDirectory } from "@openclaw/fs-safe/advanced";

/**
 * Restricted plugin-facing durable publication. It requires the native helper
 * for this one operation without changing OpenClaw's process-wide fs-safe mode.
 */
export function stageDurableFileInDirectory(
  options: Pick<Parameters<typeof stageFileInDirectory>[0], "directory" | "content" | "mode">,
) {
  return stageFileInDirectory({ ...options, nativeMode: "require" });
}

// Advanced fs-safe helpers for symlink, hardlink, and sibling-temp protections.
export {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  readFileHandleBounded,
  type FileIdentityStat,
  sameFileIdentity,
  sanitizeUntrustedFileName,
  tempFile,
} from "@openclaw/fs-safe/advanced";
export { readSecretFile } from "@openclaw/fs-safe/secret";
