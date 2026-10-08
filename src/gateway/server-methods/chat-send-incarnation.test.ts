import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import * as chatSendAttachments from "./chat-send-attachments.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();

it("admits only the selected chat incarnation before retry, stop, or turn effects", async () => {
  const fixture = await createFixture({ active: false, persistDuringDispatch: true });
  try {
    await patchSessionEntryCore(fixture.scope, () => ({ lifecycleRevision: "revision-one" }));
    const original = loadSessionEntry(fixture.scope);
    if (!original) {
      throw new Error("Fixture session was not created");
    }
    const before = loadTranscriptEventsSync(fixture.scope);
    const rejectWithoutEffects = async () => {
      const response = await fixture.send();
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(response.mock.calls[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(fixture.context.chatAbortControllers.size).toBe(0);
      expect(fixture.context.chatQueuedTurns.size).toBe(0);
      expect(
        fixture.context.dedupe.has(pendingChatSendDedupeKey(fixture.params.idempotencyKey)),
      ).toBe(false);
      expect(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(before);
    };

    fixture.params.expectedSessionId = original.sessionId;
    await rejectWithoutEffects(); // Half of a precondition cannot authorize a send.
    fixture.params.expectedSessionId = undefined;
    fixture.params.expectedLifecycleRevision = "revision-one";
    await rejectWithoutEffects();
    fixture.params.expectedSessionId = original.sessionId;
    fixture.params.expectedLifecycleRevision = "revision-one";
    await patchSessionEntryCore(fixture.scope, () => ({ lifecycleRevision: "revision-two" }));
    await rejectWithoutEffects(); // Same key and sessionId, different lifecycle.
    await patchSessionEntryCore(fixture.scope, () => ({
      sessionId: "replacement-session",
      lifecycleRevision: "revision-one",
    }));
    await rejectWithoutEffects(); // Matching revision alone cannot authorize a successor.

    await patchSessionEntryCore(fixture.scope, () => ({
      sessionId: original.sessionId,
      lifecycleRevision: "revision-one",
    }));
    const accepted = await fixture.send();
    expect(accepted.mock.calls[0]?.[0]).toBe(true);
    expect(accepted.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
    await fixture.finishDispatch();
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();

    // A cached success cannot be replayed against a changed incarnation.
    await patchSessionEntryCore(fixture.scope, () => ({ lifecycleRevision: "revision-three" }));
    const replay = await fixture.send();
    expect(replay.mock.calls[0]?.[0]).toBe(false);
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();

    fixture.params.expectedSessionId = undefined;
    fixture.params.expectedLifecycleRevision = undefined;
    fixture.params.idempotencyKey = "legacy-unpinned-send";
    const unpinned = await fixture.send();
    expect(unpinned.mock.calls[0]?.[0]).toBe(true);
    await fixture.finishDispatch();
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
  } finally {
    await fixture.cleanup();
  }
});
it("rejects a pinned send whose incarnation changes while attachments are preparing", async () => {
  const fixture = await createFixture({ active: false, persistDuringDispatch: true });
  const preparing = createDeferred<void>();
  const releasePreparation = createDeferred<void>();
  const originalPreparation = chatSendAttachments.prepareChatSendAttachments;
  const attachmentSpy = vi
    .spyOn(chatSendAttachments, "prepareChatSendAttachments")
    .mockImplementation(async (params) => {
      preparing.resolve();
      await releasePreparation.promise;
      return originalPreparation(params);
    });
  let pending: ReturnType<typeof fixture.send> | undefined;
  let successorRun: ReturnType<typeof createReplyOperation> | undefined;
  try {
    await patchSessionEntryCore(fixture.scope, () => ({ lifecycleRevision: "revision-one" }));
    const original = loadSessionEntry(fixture.scope);
    if (!original) {
      throw new Error("Fixture session was not created");
    }
    fixture.params.expectedSessionId = original.sessionId;
    fixture.params.expectedLifecycleRevision = "revision-one";
    const transcriptBefore = loadTranscriptEventsSync(fixture.scope);
    pending = fixture.send();
    await preparing.promise;
    expect(attachmentSpy).toHaveBeenCalledOnce();
    await patchSessionEntryCore(fixture.scope, () => ({
      sessionId: "successor-session",
      lifecycleRevision: "revision-two",
    }));
    const successorScope = { ...fixture.scope, sessionId: "successor-session" };
    const successorTranscriptBefore = loadTranscriptEventsSync(successorScope);
    const cancelSuccessor = vi.fn();
    const queueSuccessorMessage = vi.fn();
    successorRun = createReplyOperation({ ...successorScope, resetTriggered: false });
    successorRun.attachBackend({
      kind: "embedded",
      runId: "successor-active-run",
      cancel: cancelSuccessor,
      messageInjection: { isAvailable: () => false, queueMessage: queueSuccessorMessage },
    });
    releasePreparation.resolve();
    const response = await pending;
    expect(response.mock.calls[0]?.[0]).toBe(false);
    // The post-attachment denial uses the setup-error UNAVAILABLE response.
    expect(response.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(fixture.context.chatAbortControllers.size).toBe(0);
    expect(fixture.context.chatQueuedTurns.size).toBe(0);
    expect(
      fixture.context.dedupe.has(pendingChatSendDedupeKey(fixture.params.idempotencyKey)),
    ).toBe(false);
    expect(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
    expect(loadTranscriptEventsSync(fixture.scope)).toEqual(transcriptBefore);
    expect(cancelSuccessor).not.toHaveBeenCalled();
    expect(queueSuccessorMessage).not.toHaveBeenCalled();
    expect(listSessionPendingInputs(successorScope)).toEqual({ items: [], total: 0 });
    expect(loadTranscriptEventsSync(successorScope)).toEqual(successorTranscriptBefore);
  } finally {
    releasePreparation.resolve();
    await pending?.catch(() => {});
    successorRun?.complete();
    attachmentSpy.mockRestore();
    await fixture.cleanup();
  }
});
