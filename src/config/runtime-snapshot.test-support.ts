import { acquireRuntimeConfigSessionStoreSelection } from "./runtime-session-store-selection.js";
import { getRuntimeConfigSnapshot } from "./runtime-snapshot.js";

/** Retain the real selection owner until a test operation actually settles. */
export async function withRuntimeConfigSessionStoreSelectionAsync<T>(
  callback: () => Promise<T>,
): Promise<T> {
  const config = getRuntimeConfigSnapshot();
  if (!config) {
    throw new Error("Runtime session.store selection requires an active config snapshot");
  }
  const release = acquireRuntimeConfigSessionStoreSelection(
    config,
    "runtime-session-store-selection-async",
  );
  try {
    return await callback();
  } finally {
    release();
  }
}
