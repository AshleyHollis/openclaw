import { runSqliteReadOnlyWorker } from "./sqlite-readonly-worker.js";

/** Keep the parent-process worker launcher out of the snapshot token module's
 * synchronous child graph while providing a real lazy runtime boundary. */
export async function reclaimSqliteSnapshotDirectories(
  root: string,
  signal: AbortSignal,
): Promise<string[]> {
  return await runSqliteReadOnlyWorker(root, { mode: "reclaim", signal });
}
