// Retained SDK contracts; fs-safe owns native staging and no-replace publication.
import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe";
import {
  assertDirectoryIdentitySync,
  retainEntryForPublication,
  stageFileInDirectory,
} from "@openclaw/fs-safe/advanced";

/** Prepare a native retained stage without changing the process-wide helper policy. */
export function stageDurableFileInDirectory(
  options: Pick<Parameters<typeof stageFileInDirectory>[0], "directory" | "content" | "mode">,
) {
  return stageFileInDirectory(options);
}

/**
 * Synchronously publish an identified sibling directory, never replacing a target.
 * The caller must own the source namespace and keep its topology stable through
 * settlement. Destination absence is atomic; POSIX source identity is not CAS.
 */
export function publishDurableDirectoryNoReplace(
  options: Readonly<{
    stagedDir: string;
    targetDir: string;
    expectedIdentity: Readonly<{ dev: bigint; ino: bigint }>;
    assertBeforeMutation?: () => void;
  }>,
) {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new FsSafeError("unsupported-platform", "directory publication requires Linux or macOS");
  }
  const stagedDir = path.resolve(options.stagedDir);
  const targetDir = path.resolve(options.targetDir);
  const parent = path.dirname(stagedDir);
  if (parent !== path.dirname(targetDir) || stagedDir === targetDir) {
    throw new FsSafeError("invalid-path", "directory publication requires distinct sibling paths");
  }
  // Keep this parent descriptor until durability is settled; the dependency's
  // publication capability separately owns admission, native mutation and close.
  const parentFd = fs.openSync(
    parent,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  let publication: "not-published" | "published" | "indeterminate" = "not-published";
  let outcome:
    | {
        value: Readonly<{
          status: "published";
          targetDir: string;
          identity: Readonly<{ dev: bigint; ino: bigint }>;
        }>;
      }
    | { error: unknown };
  try {
    const { dev, ino } = fs.fstatSync(parentFd, { bigint: true });
    const parentIdentity = { dev, ino, realPath: parent };
    assertDirectoryIdentitySync(parent, parentIdentity);
    const retained = retainEntryForPublication({
      source: {
        parent: { path: parent, identity: { dev, ino } },
        basename: path.basename(stagedDir),
        expected: { ...options.expectedIdentity, kind: "directory" },
      },
      destination: {
        parent: { path: parent, identity: { dev, ino } },
        basename: path.basename(targetDir),
      },
      assertBeforeMutation: options.assertBeforeMutation ?? (() => {}),
    });
    const result = retained.publish();
    publication = result.transition === "committed" ? "published" : result.transition;
    if (
      result.transition !== "committed" ||
      result.issues.length ||
      result.verification !== "verified" ||
      result.resources !== "closed"
    ) {
      const cause = result.issues[0]?.cause;
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (
        publication === "not-published" &&
        result.issues.length === 1 &&
        result.resources === "closed" &&
        code !== "EEXIST" &&
        code !== "ENOTEMPTY"
      ) {
        throw cause;
      }
      throw new FsSafeError(
        code === "EEXIST" || code === "ENOTEMPTY" ? "already-exists" : "helper-failed",
        "directory publication did not settle successfully",
        { cause, details: { publication, result } },
      );
    }
    assertDirectoryIdentitySync(parent, parentIdentity);
    fs.fsyncSync(parentFd);
    outcome = {
      value: Object.freeze({
        status: "published" as const,
        targetDir,
        identity: Object.freeze({ ...options.expectedIdentity }),
      }),
    };
  } catch (error) {
    outcome = { error };
  }
  try {
    fs.closeSync(parentFd);
  } catch (error) {
    const cause = "error" in outcome ? new AggregateError([outcome.error, error]) : error;
    if (publication !== "not-published") {
      throw new FsSafeError("helper-failed", "directory publication parent close failed", {
        cause,
        details: { publication },
      });
    }
    throw cause;
  }
  if ("error" in outcome) {
    const error = outcome.error;
    if (
      publication === "published" &&
      !(error instanceof FsSafeError && error.details?.publication === "published")
    ) {
      throw new FsSafeError("helper-failed", "directory was published but settlement failed", {
        cause: error,
        details: { publication },
      });
    }
    throw error;
  }
  return outcome.value;
}
