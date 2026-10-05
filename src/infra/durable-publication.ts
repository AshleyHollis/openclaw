// Retained Life SDK contracts; the dependency owns native staging and publication.
import { stageFileInDirectory } from "@openclaw/fs-safe/advanced";
import { publishDirectoryNoReplace } from "@openclaw/fs-safe/atomic";

/** Prepare a native retained stage without changing the process-wide helper policy. */
export function stageDurableFileInDirectory(
  options: Pick<Parameters<typeof stageFileInDirectory>[0], "directory" | "content" | "mode">,
) {
  return stageFileInDirectory(options);
}

/** Synchronously publish an identified sibling directory, never replacing a target. */
export function publishDurableDirectoryNoReplace(
  options: Parameters<typeof publishDirectoryNoReplace>[0],
) {
  return publishDirectoryNoReplace(options);
}
