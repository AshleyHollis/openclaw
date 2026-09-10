// Provides stricter filesystem helpers for canonical path and symlink-sensitive operations.
import "./fs-safe-defaults.js";
import { stageFileInDirectory } from "@openclaw/fs-safe/advanced";

/** Fork contract: retained-directory staging with operation-local native and strict sync. */
export function stageDurableFileInDirectory(
  options: Pick<Parameters<typeof stageFileInDirectory>[0], "directory" | "content" | "mode">,
) {
  return stageFileInDirectory({
    directory: options.directory,
    content: options.content,
    mode: options.mode,
    nativeMode: "require",
    durability: "strict",
  });
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
