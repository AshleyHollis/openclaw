import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as transcriptReads from "../config/sessions/session-accessor.sqlite-read.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  appendSessionTranscriptMessagesByIdentity,
  withSessionTranscriptWriteLock,
} from "./session-transcript-runtime.js";

describe("append-only transcript replay", () => {
  const state = createOpenClawTestState({ prefix: "openclaw-transcript-replay-", applyEnv: false });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    await (await state).cleanup();
  });

  it("reads once and avoids rewrite snapshots during idempotent replay", async () => {
    const testState = await state;
    const scope = {
      agentId: "main",
      sessionId: "fictional-5000-message-session",
      sessionKey: "agent:main:main",
      storePath: path.join(testState.root, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    // The full ticket-sized fixture is opt-in; CI still covers the exact scan regression.
    const transcriptMessages =
      process.env.OPENCLAW_TRANSCRIPT_REPLAY_BENCHMARK === "1" ? 5_000 : 128;
    const messages = Array.from({ length: transcriptMessages }, (_, index) => ({
      eventId: `fictional-event-${index}`,
      idempotencyLookup: "scan" as const,
      message: {
        role: "user" as const,
        content: `Fictional preserved message ${index}`,
        timestamp: index + 1,
        idempotencyKey: `fictional-key-${index}`,
      },
    }));
    await appendSessionTranscriptMessagesByIdentity({ ...scope, messages });
    const fullRows = vi.spyOn(transcriptReads, "readTranscriptEventRows");
    const snapshots = vi.spyOn(transcriptReads, "readTranscriptSnapshot");
    const eventReads = vi.spyOn(transcriptReads, "loadTranscriptEventsFromDatabase");
    const replayCount = 20;
    let readMs = 0;
    let replayMs = 0;
    await withSessionTranscriptWriteLock(scope, async (locked) => {
      expect(locked).not.toHaveProperty("replaceEvents");
      const startRead = performance.now();
      const events = await locked.readEvents();
      readMs = performance.now() - startRead;
      expect(events).toHaveLength(transcriptMessages + 1);
      fullRows.mockClear();
      const startReplay = performance.now();
      for (let index = 0; index < replayCount; index++) {
        const replay = await locked.appendMessage({
          ...messages[index],
          parentId: index === 0 ? undefined : messages[index - 1].eventId,
        });
        expect(replay?.appended).toBe(false);
      }
      replayMs = performance.now() - startReplay;
    });
    const counts = {
      transcriptMessages: messages.length,
      replayCount,
      snapshotCalls: snapshots.mock.calls.length,
      eventReadCalls: eventReads.mock.calls.length,
      replayFullRowReadCalls: fullRows.mock.calls.length,
      readMs: Math.round(readMs),
      replayMs: Math.round(replayMs),
    };
    if (transcriptMessages === 5_000) {
      console.log(`transcript-replay-benchmark ${JSON.stringify(counts)}`);
    }
    expect(snapshots).not.toHaveBeenCalled();
    expect(eventReads).toHaveBeenCalledTimes(1);
    expect(fullRows).not.toHaveBeenCalled();
  }, 120_000);
});
