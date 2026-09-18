import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { toUSVString } from "node:util";
import { formatByteSize } from "@openclaw/normalization-core";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasErrnoCode } from "./errno.js";
import { resolveNodeCompileCacheEnv } from "./node-compile-cache-env.js";
import {
  runtimeProcessEntrypoints,
  SQLITE_READONLY_CHILD_ARG,
} from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import {
  SQLITE_READONLY_WORKER_MAX_BUFFER,
  type SqliteReadOnlyWorkerMode,
  type SqliteReadOnlyWorkerResult,
} from "./sqlite-readonly-worker-protocol.js";

const SQLITE_READONLY_STDERR_TAIL_CHARS = 4_000;
const SQLITE_INSPECTION_TIMEOUT_MS = 30_000;
const SQLITE_INSPECTION_TIMEOUT_MAX_MS = 30 * 60_000;
const log = createSubsystemLogger("state/sqlite");

export function resolveSqliteInspectionBudget(
  operation: string,
  pathname: string,
  sizeBytes: number | bigint | undefined,
): { timeoutMs: number; size: string } {
  // A full copy or integrity scan reads the whole file at least once.
  // 32 MiB/s is a conservative cold-cache floor on cloud block storage; the
  // fixed 30 seconds covers child startup and shutdown.
  const timeoutMs = Math.min(
    SQLITE_INSPECTION_TIMEOUT_MS + Math.ceil(Number(sizeBytes ?? 0) / (32 * 1024 * 1024)) * 1000,
    SQLITE_INSPECTION_TIMEOUT_MAX_MS,
  );
  const size =
    sizeBytes === undefined
      ? "unknown size"
      : formatByteSize(Number(sizeBytes), {
          style: "iec",
          maxUnit: "giga",
          separator: " ",
          fractionDigits: sizeBytes < 1024n ? 0 : 1,
        });
  if (timeoutMs > SQLITE_INSPECTION_TIMEOUT_MS) {
    log.debug(`SQLite ${operation} for ${pathname}: ${size}, budget ${timeoutMs / 1000} seconds`);
  }
  return { timeoutMs, size };
}

function readSqliteSnapshotBudget(pathname: string): { timeoutMs: number; size: string } {
  let sizeBytes: bigint | undefined;
  try {
    sizeBytes = fs.statSync(pathname, { bigint: true }).size;
  } catch {
    // Let the child report the source error with its normal diagnostics.
  }
  return resolveSqliteInspectionBudget("read-only snapshot", pathname, sizeBytes);
}

export function sqliteInspectionTimeoutError(
  operation: string,
  pathname: string,
  timeoutMs: number,
  size: string,
): Error {
  return new Error(
    `SQLite ${operation} timed out after ${timeoutMs / 1000} seconds (budget for ${size}) for ${pathname}. Stop the Gateway service and other OpenClaw processes using this database, then retry; if already stopped, check storage performance.`,
  );
}

type SqliteReadOnlyWorkerOutput = { failure?: string; stderr: string; stdout: string };
type SqliteReadOnlyWorkerValue = string | string[];
type SqliteReadOnlyWorkerOptions = {
  mode: SqliteReadOnlyWorkerMode;
  stagingRoot?: string;
  signal?: AbortSignal;
};

type SqliteReadOnlyWorkerScope = {
  active: boolean;
  controller: AbortController;
  pending: Set<Promise<SqliteReadOnlyWorkerValue>>;
  deadlineOwnedByCaller: boolean;
};
const readOnlyWorkerScope = new AsyncLocalStorage<SqliteReadOnlyWorkerScope>();

/** Keep child ownership attached to the logical inspection, including cancellation cleanup. */
export async function withSqliteReadOnlyWorkerScope<T>(
  operation: () => Promise<T>,
  options?: { signal: AbortSignal; deadlineOwnedByCaller: boolean },
): Promise<T> {
  if (!options && readOnlyWorkerScope.getStore()?.active) {
    return operation();
  }
  const scope: SqliteReadOnlyWorkerScope = {
    active: true,
    controller: new AbortController(),
    pending: new Set(),
    deadlineOwnedByCaller: options?.deadlineOwnedByCaller ?? false,
  };
  const abort = () => scope.controller.abort(options?.signal.reason);
  options?.signal.addEventListener("abort", abort, { once: true });
  if (options?.signal.aborted) {
    abort();
  }
  try {
    return await readOnlyWorkerScope.run(scope, operation);
  } finally {
    options?.signal.removeEventListener("abort", abort);
    scope.active = false;
    scope.controller.abort(new Error("SQLite read-only worker scope closed"));
    await Promise.allSettled(scope.pending);
  }
}

export function isSqliteInspectionDeadlineOwnedByCaller(): boolean {
  return readOnlyWorkerScope.getStore()?.deadlineOwnedByCaller === true;
}

export function resolveSqliteInspectionSignal(signal?: AbortSignal): AbortSignal | undefined {
  const scope = readOnlyWorkerScope.getStore();
  return scope
    ? signal
      ? AbortSignal.any([signal, scope.controller.signal])
      : scope.controller.signal
    : signal;
}

function isSqliteReadOnlyWorkerResult(value: unknown): value is SqliteReadOnlyWorkerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).length !== 2 || !("ok" in value)) {
    return false;
  }
  return (
    (value.ok === true && "location" in value && typeof value.location === "string") ||
    (value.ok === true &&
      "warnings" in value &&
      Array.isArray(value.warnings) &&
      value.warnings.every((warning) => typeof warning === "string")) ||
    (value.ok === false && "message" in value && typeof value.message === "string")
  );
}

function createSqliteReadOnlyWorkerError(message: string, stderr: string): Error {
  // Node can split a decoded surrogate pair when its child stderr buffer overflows.
  const stderrTail = toUSVString(sliceUtf16Safe(stderr.trim(), -SQLITE_READONLY_STDERR_TAIL_CHARS));
  return new Error(
    `SQLite read-only worker ${message}${stderrTail ? `\nstderr (tail): ${stderrTail}` : ""}`,
  );
}

function parseSqliteReadOnlyWorkerResult(
  stdout: string,
  stderr: string,
): SqliteReadOnlyWorkerResult {
  if (!stdout.trim()) {
    throw createSqliteReadOnlyWorkerError("returned no JSON result", stderr);
  }
  let message: unknown;
  try {
    message = JSON.parse(stdout);
  } catch {
    throw createSqliteReadOnlyWorkerError("returned invalid JSON", stderr);
  }
  if (!isSqliteReadOnlyWorkerResult(message)) {
    throw createSqliteReadOnlyWorkerError("returned an invalid result", stderr);
  }
  return message;
}

function readSqliteReadOnlyWorkerValue(
  params: SqliteReadOnlyWorkerOutput,
  mode: SqliteReadOnlyWorkerMode,
): string | string[] {
  let result: SqliteReadOnlyWorkerResult;
  try {
    result = parseSqliteReadOnlyWorkerResult(params.stdout, params.stderr);
  } catch (error) {
    if (params.failure) {
      throw createSqliteReadOnlyWorkerError(params.failure, params.stderr);
    }
    throw error;
  }
  if (params.failure || !result.ok) {
    throw createSqliteReadOnlyWorkerError(
      !result.ok ? result.message : (params.failure ?? "failed"),
      params.stderr,
    );
  }
  if ((mode === "sync" || mode === "async") && "location" in result) {
    return result.location;
  }
  if (mode === "reclaim" && "warnings" in result) {
    return result.warnings;
  }
  throw createSqliteReadOnlyWorkerError(
    "returned a result for a different operation",
    params.stderr,
  );
}

function sqliteReadOnlyWorkerArgv(
  pathname: string,
  mode: SqliteReadOnlyWorkerMode,
  stagingRoot?: string,
) {
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly);
  return [
    ...resolveRuntimeWorkerArgv(workerUrl),
    SQLITE_READONLY_CHILD_ARG,
    mode,
    path.resolve(pathname),
    ...(stagingRoot ? [stagingRoot] : []),
  ];
}

export function runSqliteReadOnlyWorker(
  pathname: string,
  options: { mode: "sync" | "async"; stagingRoot?: string; signal?: AbortSignal },
): Promise<string>;
export function runSqliteReadOnlyWorker(
  pathname: string,
  options: { mode: "reclaim"; signal?: AbortSignal },
): Promise<string[]>;
export function runSqliteReadOnlyWorker(
  pathname: string,
  options: SqliteReadOnlyWorkerOptions,
): Promise<string | string[]> {
  if (options.mode === "reclaim") {
    return readOnlyWorkerScope.exit(() => runSqliteReadOnlyWorkerOnce(pathname, options));
  }
  const scope = readOnlyWorkerScope.getStore();
  if (!scope) {
    return runSqliteReadOnlyWorkerOnce(pathname, options);
  }
  if (!scope.active) {
    return Promise.reject(new Error("SQLite read-only worker scope closed"));
  }
  const operation = runSqliteReadOnlyWorkerOnce(pathname, {
    ...options,
    signal: options.signal
      ? AbortSignal.any([options.signal, scope.controller.signal])
      : scope.controller.signal,
  });
  scope.pending.add(operation);
  void operation.then(
    () => scope.pending.delete(operation),
    () => scope.pending.delete(operation),
  );
  return operation;
}

function runSqliteReadOnlyWorkerOnce(
  pathname: string,
  options: SqliteReadOnlyWorkerOptions,
): Promise<SqliteReadOnlyWorkerValue> {
  return new Promise<SqliteReadOnlyWorkerValue>((resolve, reject) => {
    const { timeoutMs, size } = readSqliteSnapshotBudget(pathname);
    let output: SqliteReadOnlyWorkerOutput = { stderr: "", stdout: "" };
    let stopped = false;
    let reclamationDeadline = false;
    const reclaim = options.mode === "reclaim";
    const child = execFile(
      process.execPath,
      sqliteReadOnlyWorkerArgv(pathname, options.mode, options.stagingRoot),
      {
        encoding: "utf8",
        env: resolveNodeCompileCacheEnv(),
        maxBuffer: SQLITE_READONLY_WORKER_MAX_BUFFER,
        timeout: reclaim || isSqliteInspectionDeadlineOwnedByCaller() ? undefined : timeoutMs,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        output = {
          failure: error
            ? stopped
              ? "snapshot owner stopped"
              : error.killed && error.signal === "SIGKILL" && error.code == null
                ? sqliteInspectionTimeoutError("read-only snapshot", pathname, timeoutMs, size)
                    .message
                : `exited unsuccessfully: ${error.message}`
            : undefined,
          stderr,
          stdout,
        };
      },
    );
    // execFile does not forward killSignal for AbortSignal cancellation.
    const abort = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (reclaim) {
        child.stdin?.end();
      } else {
        child.kill("SIGKILL");
      }
    };
    const timer = reclaim
      ? setTimeout(() => {
          reclamationDeadline = true;
          abort();
        }, timeoutMs)
      : undefined;
    void retainSnapshotWork(
      new Promise<void>((resolveClosed) => {
        child.once("close", () => resolveClosed());
      }),
      abort,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }
    // execFile can report an abort/error before close. Ownership ends only
    // after the process and its pipes have closed, including failed launches.
    child.once("close", () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      try {
        if (options.mode === "reclaim") {
          const warnings = readSqliteReadOnlyWorkerValue(output, "reclaim") as string[];
          if (reclamationDeadline) {
            warnings.push(
              sqliteInspectionTimeoutError("reclamation", pathname, timeoutMs, size).message,
            );
          }
          resolve(warnings);
          return;
        }
        options.signal?.throwIfAborted();
        resolve(readSqliteReadOnlyWorkerValue(output, options.mode) as string);
      } catch (workerError) {
        reject(workerError instanceof Error ? workerError : new Error(String(workerError)));
      }
    });
  });
}

export function runSqliteReadOnlyWorkerSync(pathname: string, stagingRoot: string): string {
  const { timeoutMs, size } = readSqliteSnapshotBudget(pathname);
  const result = spawnSync(
    process.execPath,
    sqliteReadOnlyWorkerArgv(pathname, "sync", stagingRoot),
    {
      encoding: "utf8",
      env: resolveNodeCompileCacheEnv(),
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    },
  );
  const failure = result.error
    ? hasErrnoCode(result.error, "ETIMEDOUT")
      ? sqliteInspectionTimeoutError("read-only snapshot", pathname, timeoutMs, size).message
      : `failed to start: ${result.error.message}`
    : result.status === 0
      ? undefined
      : `exited with ${result.signal ? `signal ${result.signal}` : `code ${result.status}`}`;
  return readSqliteReadOnlyWorkerValue(
    {
      failure,
      stderr: result.stderr,
      stdout: result.stdout,
    },
    "sync",
  ) as string;
}
