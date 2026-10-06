import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { type AgentEventPayload, emitAgentEvent } from "../infra/agent-events.js";
import { claimAgentRunContext } from "../infra/agent-run-registry.js";
import { waitForChatAbortTerminalPersistence } from "./chat-abort-lifecycle-internal.js";
import { removeChatAbortControllerEntry } from "./chat-abort.js";
import { createGatewayServerActiveWorkInspectors } from "./server-active-work.js";
import type { AgentEventHandlerOptions } from "./server-chat.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import {
  type createSubscriptionTestFixture,
  registerSubscriptionChatRun,
} from "./server-runtime-subscriptions.test-support.js";

export function registerTerminalOwnershipTests(fixtures: {
  createParams: ReturnType<typeof createSubscriptionTestFixture>["createParams"];
  warn: ReturnType<typeof createSubscriptionTestFixture>["warn"];
  start: (params: Parameters<typeof startGatewayEventSubscriptions>[0]) => void;
  agentEventHandlerMocks: {
    create: {
      mockImplementation: (handler: (options: AgentEventHandlerOptions) => unknown) => unknown;
    };
    persistLifecycle: { mockReturnValue: (promise: Promise<void>) => unknown };
  };
}) {
  const { createParams, warn, start, agentEventHandlerMocks } = fixtures;
  const waitForFast = (callback: () => unknown) => vi.waitFor(callback, { interval: 1 });

  it.each(
    [true, false].flatMap((persisted) =>
      [true, false].flatMap((newerFinishesFirst) =>
        [true, false].map((newerFails) => ({ persisted, newerFinishesFirst, newerFails })),
      ),
    ),
  )(
    "retains terminal ownership across overlapping work (persisted=$persisted, newerFinishesFirst=$newerFinishesFirst, newerFails=$newerFails)",
    async ({ persisted, newerFinishesFirst, newerFails }) => {
      const actual = await vi.importActual<typeof import("./server-chat.js")>("./server-chat.js");
      const params = createParams();
      const runId = "older-write-newer-dispatch";
      const sessionKey = "agent:main:older-write-newer-dispatch";
      const registration = registerSubscriptionChatRun(params, {
        runId,
        sessionId: "older-write-session",
        sessionKey,
      });
      const entry = registration.entry;
      const inspectors = createGatewayServerActiveWorkInspectors({
        chatAbortControllers: params.chatAbortControllers,
        chatQueuedTurns: new Map(),
        cron: {},
        terminalSessions: undefined,
      });
      const olderWrite = createDeferred();
      const olderHandled = createDeferred();
      const newerEntered = createDeferred();
      const releaseNewer = createDeferred();
      const failure = new Error("older accepted write failed");
      const newerFailure = new Error("newer terminal dispatch failed");
      agentEventHandlerMocks.persistLifecycle.mockReturnValue(olderWrite.promise);
      agentEventHandlerMocks.create.mockImplementation((options: AgentEventHandlerOptions) => {
        const handler = actual.createAgentEventHandler(options);
        return Object.assign(
          async (event: AgentEventPayload) => {
            if (event.data.endedAt === 3_000) {
              newerEntered.resolve();
              await releaseNewer.promise;
              if (newerFails) {
                throw newerFailure;
              }
            }
            handler(event);
            if (event.data.endedAt === 2_000) {
              olderHandled.resolve();
            }
          },
          { dispose: () => handler.dispose() },
        );
      });
      start(params);
      const emitTerminal = (endedAt: number, projectSessionLifecycle?: boolean) => {
        claimAgentRunContext(runId, {
          sessionKey,
          sessionId: entry.sessionId,
          projectSessionLifecycle,
        });
        emitAgentEvent({
          runId,
          sessionKey,
          sessionId: entry.sessionId,
          stream: "lifecycle",
          data: { phase: "end", endedAt },
        });
      };
      let newerResult: Promise<unknown> | undefined;
      try {
        emitTerminal(2_000);
        await olderHandled.promise;
        expect(entry.projectSessionTerminalPersistence).toBe(olderWrite.promise);
        emitTerminal(3_000, false);
        newerResult = waitForChatAbortTerminalPersistence(entry).then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
        await newerEntered.promise;
        registration.cleanup();
        if (newerFinishesFirst) {
          releaseNewer.resolve();
          await waitForFast(() => expect(entry.projectSessionTerminalPending).toBe(false));
          if (newerFails) {
            expect(warn).toHaveBeenCalledWith(
              "Agent event dispatch failed",
              expect.objectContaining({ error: newerFailure }),
            );
          }
          expect(entry.projectSessionTerminalPending).toBe(false);
          expect(entry.projectSessionTerminalPersistence).toBe(olderWrite.promise);
          expect(params.chatAbortControllers.get(runId)).toBe(entry);
          expect(inspectors.getTerminalPersistence?.()).toBe(1);
        }
        if (persisted) {
          olderWrite.resolve();
        } else {
          olderWrite.reject(failure);
        }
        await waitForFast(() => expect(entry.projectSessionTerminalPersistence).toBeUndefined());
        expect(entry.projectSessionTerminalPending).toBe(!newerFinishesFirst);
        expect(entry.projectSessionTerminalPersisted).toBe(persisted);
        expect(params.chatAbortControllers.get(runId)).toBe(newerFinishesFirst ? undefined : entry);
        expect(inspectors.getTerminalPersistence?.()).toBe(newerFinishesFirst ? 0 : 1);
        releaseNewer.resolve();
        const expectedFailure = persisted ? (newerFails ? newerFailure : undefined) : failure;
        expect(await newerResult).toEqual(
          expectedFailure ? { ok: false, error: expectedFailure } : { ok: true },
        );
        expect(entry.projectSessionTerminalPending).toBe(false);
        expect(entry.projectSessionTerminalPersisted).toBe(persisted);
        if (expectedFailure) {
          await expect(waitForChatAbortTerminalPersistence(entry)).rejects.toBe(expectedFailure);
        } else {
          await expect(waitForChatAbortTerminalPersistence(entry)).resolves.toBeUndefined();
        }
        expect(params.chatAbortControllers.size).toBe(0);
      } finally {
        olderWrite.resolve();
        releaseNewer.resolve();
        await Promise.allSettled([olderWrite.promise, newerResult]);
        removeChatAbortControllerEntry(params.chatAbortControllers, runId, entry);
      }
    },
  );
}
