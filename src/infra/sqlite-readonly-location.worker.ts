import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import { formatSqliteErrorCodeSuffix } from "./sqlite-error-diagnostics.js";
import { releaseSnapshotTempDirectory } from "./sqlite-readonly-location-cleanup.js";
import {
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";
import {
  SQLITE_READONLY_WORKER_MAX_BUFFER,
  type SqliteReadOnlyWorkerResult,
} from "./sqlite-readonly-worker-protocol.js";
import { reclaimAbandonedSqliteSnapshots } from "./sqlite-snapshot-staging.js";

// The sync strategy raw-copies without attaching SQLite to the source, so sync
// callers stay byte-neutral on the live family; the async strategy holds a read
// transaction on the source and may update its WAL index.
async function inspect(args: string[]): Promise<SqliteReadOnlyWorkerResult> {
  const mode = args[0];
  const pathname = args[1];
  const stagingRoot = args[2];
  if ((mode !== "sync" && mode !== "async" && mode !== "reclaim") || !pathname) {
    return {
      ok: false,
      message: "SQLite read-only worker requires a mode and a database path",
    };
  }
  try {
    if (mode === "reclaim") {
      const warnings: string[] = [];
      const directories = reclaimAbandonedSqliteSnapshots(pathname, (message, error) => {
        warnings.push(`${message}${formatSqliteErrorCodeSuffix(error)}`);
      });
      let stopped = false;
      const stop = () => {
        stopped = true;
      };
      process.stdin.once("end", stop);
      process.stdin.once("error", stop);
      process.stdin.resume();
      try {
        while (true) {
          await setImmediate();
          if (stopped) {
            warnings.push("Stopped SQLite snapshot reclamation at a directory boundary.");
            break;
          }
          if (directories.next().done) {
            break;
          }
        }
      } finally {
        directories.return(undefined);
        process.stdin.off("end", stop);
        process.stdin.off("error", stop);
        process.stdin.destroy();
      }
      return { ok: true, warnings };
    }
    const prepared =
      mode === "sync"
        ? prepareSqliteReadOnlyLocationSyncInProcess(pathname, stagingRoot)
        : await prepareSqliteReadOnlyLocationInProcess(pathname, stagingRoot);
    releaseSnapshotTempDirectory(prepared.cleanupRoot ?? path.dirname(prepared.location));
    return { ok: true, location: prepared.location };
  } catch (error) {
    const message = `${coerceErrorMessage(error)}${formatSqliteErrorCodeSuffix(error)}`;
    return { ok: false, message };
  }
}

if (process.argv[2] === SQLITE_READONLY_CHILD_ARG) {
  void inspect(process.argv.slice(3)).then((result) => {
    if (!result.ok) {
      process.exitCode = 1;
    }
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) > SQLITE_READONLY_WORKER_MAX_BUFFER) {
      process.exitCode = 1;
      process.stdout.write(JSON.stringify({ ok: false, message: "exceeded its output buffer" }));
      return;
    }
    process.stdout.write(encoded);
  });
}
