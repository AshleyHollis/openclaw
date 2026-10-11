import type { OpenClawConfig } from "./types.js";

const admittedSessionStoreSelections = new Map<symbol, string | undefined>();
const sessionStoreSelectionReleaseListeners = new Set<() => void>();

export class RuntimeConfigSessionStoreSelectionHeldError extends Error {}

export function isRuntimeConfigSessionStoreSelectionHeld(): boolean {
  return admittedSessionStoreSelections.size > 0;
}

/** Called when the last admission settles, including a rejected async operation. */
export function onRuntimeConfigSessionStoreSelectionReleased(listener: () => void): () => void {
  sessionStoreSelectionReleaseListeners.add(listener);
  return () => {
    sessionStoreSelectionReleaseListeners.delete(listener);
  };
}

function releaseSessionStoreSelection(owner: symbol): void {
  admittedSessionStoreSelections.delete(owner);
  if (admittedSessionStoreSelections.size === 0) {
    for (const listener of sessionStoreSelectionReleaseListeners) {
      try {
        listener();
      } catch {
        // An observer cannot extend or revoke an already-settled admission.
      }
    }
  }
}

export function assertSessionStoreSelection(config: OpenClawConfig): void {
  for (const selection of admittedSessionStoreSelections.values()) {
    if (selection !== config.session?.store) {
      throw new RuntimeConfigSessionStoreSelectionHeldError(
        "Runtime session.store selection cannot change during admission",
      );
    }
  }
}

/** Acquire the existing selection owner after checking every held selection. */
export function acquireRuntimeConfigSessionStoreSelection(
  config: OpenClawConfig,
  ownerDescription: string,
): () => void {
  assertSessionStoreSelection(config);
  const owner = Symbol(ownerDescription);
  admittedSessionStoreSelections.set(owner, config.session?.store);
  return () => releaseSessionStoreSelection(owner);
}

/** Run the synchronous callback and release its existing selection owner. */
export function runRuntimeConfigSessionStoreSelectionCallback<T>(
  callback: () => T,
  release: () => void,
): T {
  try {
    const result = callback();
    if (
      result &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      throw new Error("Runtime session.store selection admission must be synchronous");
    }
    return result;
  } finally {
    release();
  }
}
