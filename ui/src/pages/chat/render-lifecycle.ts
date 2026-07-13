export type CancelAfterCommit = () => void;
export type CompleteAfterCommit = () => void;
export type AfterCommitEffect = (complete: CompleteAfterCommit) => CancelAfterCommit | void;

type ChatPageUpdateHost = {
  chatStreamRenderFrame: number | null;
  requestUpdate?: () => void;
};

type ChatPageUpdateMode = "immediate" | "animation-frame";

export function cancelChatStreamRenderFrame(
  state: Pick<ChatPageUpdateHost, "chatStreamRenderFrame">,
): void {
  const frame = state.chatStreamRenderFrame;
  if (frame == null) {
    return;
  }
  state.chatStreamRenderFrame = null;
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(frame);
  }
}

export function requestChatPageUpdate(
  state: ChatPageUpdateHost,
  mode: ChatPageUpdateMode = "immediate",
): void {
  if (mode === "immediate" || typeof globalThis.requestAnimationFrame !== "function") {
    cancelChatStreamRenderFrame(state);
    state.requestUpdate?.();
    return;
  }
  if (state.chatStreamRenderFrame != null) {
    return;
  }
  // Deltas still mutate the canonical stream immediately. One frame owns the
  // paint; terminal/non-stream events cancel it so stale partial UI cannot win.
  let frame = 0;
  frame = globalThis.requestAnimationFrame(() => {
    if (state.chatStreamRenderFrame !== frame) {
      return;
    }
    state.chatStreamRenderFrame = null;
    state.requestUpdate?.();
  });
  state.chatStreamRenderFrame = frame;
}

/**
 * Renderer-neutral boundary for state invalidation and DOM-dependent effects.
 * `afterCommit` must request a render before waiting for its commit.
 */
export interface RenderLifecycle {
  invalidate(): void;
  /**
   * Run after the next commit. Async follow-up work returns its cleanup and
   * calls `complete` when done so the lifecycle owns it through teardown.
   */
  afterCommit(effect: AfterCommitEffect, onCancel?: () => void): CancelAfterCommit;
}
