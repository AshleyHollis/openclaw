import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptEvent,
  listSessionEntriesCore,
  loadSessionEntry,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as sqliteSessionScope from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../config/sessions/transcript-write-context.js";
import * as transcriptEvents from "../sessions/transcript-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  appendAssistantMirrorMessageByIdentity,
  appendSessionTranscriptMessageByIdentity,
  appendSessionYieldContext,
  formatSessionTranscriptMemoryHitKey,
  parseSessionTranscriptMemoryHitKey,
  publishSessionTranscriptUpdateByIdentity,
  redactSessionTranscriptMessage,
  readSessionTranscriptRawDelta,
  resolveSessionTranscriptIdentity,
  resolveSessionTranscriptTarget,
  readLatestAssistantTextByIdentity,
  readSessionTranscriptEvents,
  readVisibleSessionTranscriptMessageEntries,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
  withSessionTranscriptWriteLock,
  type SessionTranscriptReadParams,
} from "./session-transcript-runtime.js";

describe("session transcript runtime SDK", () => {
  let state: OpenClawTestState;
  let storePath: string;
  let tempDir: string;
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-sdk-transcript-", applyEnv: false });
    tempDir = state.root;
    storePath = state.path("sessions.json");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    await state.cleanup();
  });

  function transcriptScope(sessionId: string, sessionKey = "agent:main:main") {
    return { agentId: "main", sessionId, sessionKey, storePath };
  }

  async function createScope(sessionId = "session") {
    const scope = { agentId: "main", sessionId, sessionKey: "agent:main:main", storePath };
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 10 });
    return scope;
  }
  const entries = (scope: SessionTranscriptReadParams) =>
    readVisibleSessionTranscriptMessageEntries(scope);
  const append = (scope: SessionTranscriptReadParams, role: string, content: string) =>
    appendSessionTranscriptMessageByIdentity({ ...scope, message: { role, content } });

  it("appends keyed mirrors, dedupes unkeyed mirrors, and rejects a rebound session", async () => {
    const scope = await createScope();
    for (const idempotencyKey of ["delivery-1", "delivery-2"]) {
      await expect(
        appendAssistantMirrorMessageByIdentity({
          ...scope,
          idempotencyKey,
          deliveryMirror: { kind: "channel-final", sourceMessageId: idempotencyKey },
          text: "visible assistant reply",
        }),
      ).resolves.toMatchObject({ ok: true, messageId: expect.any(String) });
    }
    await expect(readLatestAssistantTextByIdentity(scope)).resolves.toBeUndefined();
    expect(await entries(scope)).toHaveLength(2);
    const unkeyed = await createScope("unkeyed");
    const request = { ...unkeyed, text: "unkeyed assistant reply" };
    const first = await appendAssistantMirrorMessageByIdentity(request);
    expect(first).toMatchObject({ ok: true, messageId: expect.any(String) });
    await expect(appendAssistantMirrorMessageByIdentity(request)).resolves.toEqual(first);
    expect(await entries(unkeyed)).toHaveLength(1);
    await expect(
      appendAssistantMirrorMessageByIdentity({ ...scope, text: "stale reply" }),
    ).resolves.toMatchObject({ ok: false, code: "session-rebound" });
  });

  it("does not append an assistant mirror after cancellation", async () => {
    const scope = await createScope();
    const cancellation = new Error("cancelled by user");
    await expect(
      appendAssistantMirrorMessageByIdentity({
        ...scope,
        signal: AbortSignal.abort(cancellation),
        text: "must not be persisted",
      }),
    ).rejects.toBe(cancellation);
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it.each(["assistant mirror", "yield context"])(
    "rejects %s after its admitted writer is superseded",
    async (operation) => {
      const scope = await createScope();
      await upsertSessionEntryCore(scope, {
        activeWriterRunId: "replacement-run",
        lifecycleRevision: "revision-a",
        sessionId: scope.sessionId,
        updatedAt: 10,
      });
      await expect(
        withOwnedSessionTranscriptWrites(
          {
            sessionKey: scope.sessionKey,
            sessionTarget: {
              ...scope,
              expectedLifecycleRevision: "revision-a",
              expectedWriterRunId: "superseded-run",
            },
            withTranscriptWrite: async (run) => await run(),
          },
          async () => {
            if (operation === "yield context") {
              await appendSessionYieldContext({
                ...scope,
                message: "must not be persisted",
                assertCurrent: () => {},
              });
            } else {
              await appendAssistantMirrorMessageByIdentity({
                ...scope,
                idempotencyKey: "superseded:fallback",
                text: "must not be persisted",
              });
            }
          },
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
      await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([]);
    },
  );

  it("rechecks yield settlement authority after waiting for the transcript writer", async () => {
    const scope = await createScope();
    let active = true;
    const stopped = new Error("yield settlement stopped");
    const writerEntered = createDeferredCore();
    const releaseWriter = createDeferredCore();
    const heldWriter = withSessionTranscriptWriteLock(scope, async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
    });
    await writerEntered.promise;
    try {
      const write = appendSessionYieldContext({
        ...scope,
        message: "private continuation",
        assertCurrent: () => {
          if (!active) {
            throw stopped;
          }
        },
      });
      const rejected = expect(write).rejects.toBe(stopped);
      active = false;
      releaseWriter.resolve();
      await heldWriter;
      await rejected;
    } finally {
      releaseWriter.resolve();
      await heldWriter;
    }
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it("dedupes unkeyed assistant mirrors against only the visible SQLite branch", async () => {
    const scope = await createScope();
    const active = await append(scope, "assistant", "visible branch reply");
    const inactive = await append(scope, "assistant", "inactive mirror reply");
    assert(active && inactive);
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "select-active",
      parentId: inactive.messageId,
      targetId: active.messageId,
    });
    const result = await appendAssistantMirrorMessageByIdentity({
      ...scope,
      text: "inactive mirror reply",
    });
    assert(result.ok);
    expect(result.messageId).not.toBe(inactive.messageId);
    await expect(readSessionTranscriptEvents(scope)).resolves.toContainEqual(
      expect.objectContaining({ id: inactive.messageId }),
    );
    expect(await entries(scope)).toMatchObject([
      { entryId: active.messageId },
      { entryId: result.messageId },
    ]);
  });

  it("does not dedupe unkeyed assistant mirrors across a later user turn", async () => {
    const scope = await createScope();
    const first = await append(scope, "assistant", "repeatable answer");
    await append(scope, "user", "next question");
    const result = await appendAssistantMirrorMessageByIdentity({
      ...scope,
      text: "repeatable answer",
    });
    assert(first && result.ok);
    expect(result.messageId).not.toBe(first.messageId);
    expect((await entries(scope)).map((entry) => entry.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("publishes assistant mirror updates only for newly appended notified rows", async () => {
    const scope = await createScope();
    const updates: unknown[] = [];
    const off = transcriptEvents.onInternalSessionTranscriptUpdate((update) =>
      updates.push(update),
    );
    try {
      await expect(
        appendAssistantMirrorMessageByIdentity({
          ...scope,
          text: "quiet reply",
          updateMode: "none",
        }),
      ).resolves.toMatchObject({ ok: true, messageId: expect.any(String) });
      expect(updates).toEqual([]);
      const request = { ...scope, idempotencyKey: "mirror-once", text: "notified reply" };
      const first = await appendAssistantMirrorMessageByIdentity(request);
      assert(first.ok);
      await expect(appendAssistantMirrorMessageByIdentity(request)).resolves.toEqual(first);
      expect(updates).toEqual([
        expect.objectContaining({
          messageId: first.messageId,
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
        }),
      ]);
    } finally {
      off();
    }
  });

  it("serializes caller-checked idempotency inside scoped locked appends", async () => {
    const scope = {
      agentId: "main",
      sessionId: "caller-checked-lock-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const steps: string[] = [];
    const firstRead = createDeferredCore();
    const releaseFirst = createDeferredCore();
    const secondQueued = createDeferredCore();
    const enqueueWrite = sqliteSessionScope.runExclusiveSqliteSessionWrite;
    let queuedWrites = 0;
    vi.spyOn(sqliteSessionScope, "runExclusiveSqliteSessionWrite").mockImplementation((...args) => {
      const pending = enqueueWrite(...args);
      // This owner enqueues synchronously; observe contention after delegating to the real queue.
      if (args[2] === "session.transcript.locked-write" && ++queuedWrites === 2) {
        secondQueued.resolve();
      }
      return pending;
    });
    let enteredWrites = 0;
    const appendIfMissing = async () =>
      await withSessionTranscriptWriteLock(scope, async (locked) => {
        // Target preparation can finish out of order before either caller acquires the lock.
        const label = ++enteredWrites === 1 ? "first" : "second";
        steps.push(`${label}:read`);
        const events = await locked.readEvents();
        const alreadyAppended = events.some((event) => {
          const message = (event as { message?: { idempotencyKey?: unknown } }).message;
          return message?.idempotencyKey === "mirror-once";
        });
        if (label === "first") {
          firstRead.resolve();
          await releaseFirst.promise;
        }
        if (!alreadyAppended) {
          await locked.appendMessage({
            idempotencyLookup: "caller-checked",
            message: {
              role: "assistant",
              content: [{ type: "text", text: label }],
              idempotencyKey: "mirror-once",
              timestamp: 1,
            },
          });
        }
        steps.push(`${label}:done`);
      });

    const first = appendIfMissing();
    const second = appendIfMissing();
    const writes = Promise.all([first, second]);
    try {
      await Promise.race([Promise.all([firstRead.promise, secondQueued.promise]), writes]);
      expect(steps).toEqual(["first:read"]);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
    }
    await writes;

    expect(steps).toEqual(["first:read", "first:done", "second:read", "second:done"]);
    const assistantMessages = (await readSessionTranscriptEvents(scope)).filter((event) => {
      const message = (event as { message?: { role?: unknown } }).message;
      return message?.role === "assistant";
    });
    expect(assistantMessages).toHaveLength(1);
  });

  it("does not publish queued locked updates when the callback throws", async () => {
    const scope = await createScope();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    await expect(
      withSessionTranscriptWriteLock(scope, async (locked) => {
        await locked.appendMessage({
          message: { role: "assistant", content: "durable but failed", timestamp: 1 },
        });
        await locked.publishUpdate({ sessionKey: scope.sessionKey });
        throw new Error("stop before commit");
      }),
    ).rejects.toThrow("stop before commit");
    expect(emitSpy).not.toHaveBeenCalled();
    expect(await entries(scope)).toMatchObject([
      { message: { role: "assistant", content: "durable but failed" } },
    ]);
  });

  it("resolves encoded memory hit keys by agent and opaque session id instead of transcript basename", async () => {
    const scope = await createScope("my-plugin:task/1");
    await upsertSessionEntryCore(scope, {
      sessionFile: state.path("legacy-file-name.jsonl"),
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    const key = formatSessionTranscriptMemoryHitKey(scope);
    expect(key).toBe("transcript:main:my-plugin%3Atask%2F1");
    expect(
      resolveSessionTranscriptMemoryHitKeyToSessionKeys({
        key,
        store: Object.fromEntries(
          listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
        ),
      }),
    ).toEqual([scope.sessionKey]);
  });

  it("can avoid synthetic fallback keys for strict live-store checks", () => {
    const key = formatSessionTranscriptMemoryHitKey({
      agentId: "main",
      sessionId: "deleted-session",
    });
    expect(resolveSessionTranscriptMemoryHitKeyToSessionKeys({ key, store: {} })).toEqual([
      "agent:main:deleted-session",
    ]);
    expect(
      resolveSessionTranscriptMemoryHitKeyToSessionKeys({
        includeSyntheticFallback: false,
        key,
        store: {},
      }),
    ).toEqual([]);
  });
  it("resolves transcript identity and reads events without returning sessionFile", async () => {
    const scope = {
      agentId: "Main",
      sessionId: "session-with-colon",
      sessionKey: "agent:main:main",
      storePath,
    };
    const event = { id: "event-1", type: "metadata" };

    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    await appendTranscriptEvent(scope, event);

    const identity = await resolveSessionTranscriptIdentity(scope);

    expect(identity).toEqual({
      agentId: "main",
      memoryKey: "transcript:main:session-with-colon",
      sessionId: scope.sessionId,
      sessionKey: "agent:main:main",
    });
    expect(identity).not.toHaveProperty("sessionFile");
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([event]);
  });

  it("projects supplied transcript messages through storage redaction without mutation", () => {
    const message = {
      content: "email fictional@example.test",
      role: "user",
      timestamp: 1,
    } as const;
    const config = {
      logging: { redactPatterns: ["fictional@example\\.test"] },
    };

    const projected = redactSessionTranscriptMessage(message, config);

    expect(projected).not.toBe(message);
    expect(projected).toMatchObject({
      content: expect.not.stringContaining("fictional@example.test"),
      role: "user",
    });
    expect(message).toEqual({
      content: "email fictional@example.test",
      role: "user",
      timestamp: 1,
    });
  });

  it("does not persist sessionFile metadata for identity-only reads", async () => {
    const scope = transcriptScope("read-only-session");

    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });

    await expect(resolveSessionTranscriptIdentity(scope)).resolves.toMatchObject({
      memoryKey: "transcript:main:read-only-session",
    });
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([]);
    expect(loadSessionEntry(scope)?.sessionFile).toBeUndefined();
  });

  it("pages raw events across appends and resets after replacement", async () => {
    const scope = transcriptScope("raw-delta-session", "agent:main:raw-delta");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    for (const id of ["event-1", "event-2", "event-3"]) {
      await appendTranscriptEvent(scope, { id, type: "custom" });
    }

    const first = await readSessionTranscriptRawDelta({
      ...scope,
      maxBytes: 10_000,
      maxEvents: 2,
    });
    expect(first).toMatchObject({
      kind: "page",
      events: [
        { event: { id: "event-1", type: "custom" }, seq: 0 },
        { event: { id: "event-2", type: "custom" }, seq: 1 },
      ],
      hasMore: true,
    });
    if (first.kind !== "page") {
      throw new Error("expected the first raw transcript page");
    }

    await appendTranscriptEvent(scope, { id: "event-4", type: "custom" });
    const second = await readSessionTranscriptRawDelta({
      ...scope,
      cursor: first.cursor,
      maxBytes: 10_000,
      maxEvents: 2,
    });
    expect(second).toMatchObject({
      kind: "page",
      events: [
        { event: { id: "event-3", type: "custom" }, seq: 2 },
        { event: { id: "event-4", type: "custom" }, seq: 3 },
      ],
      hasMore: false,
    });

    await replaceTranscriptEvents(scope, [{ id: "replacement", type: "custom" }]);
    await expect(
      readSessionTranscriptRawDelta({
        ...scope,
        cursor: first.cursor,
        maxBytes: 10_000,
        maxEvents: 2,
      }),
    ).resolves.toMatchObject({ kind: "reset", reason: "generation_mismatch" });
  });

  it("bounds raw pages before parsing an oversized event", async () => {
    const missingScope = transcriptScope("missing-raw-delta", "agent:main:missing-raw-delta");
    await upsertSessionEntryCore(missingScope, {
      sessionId: missingScope.sessionId,
      updatedAt: 10,
    });
    await expect(
      readSessionTranscriptRawDelta({ ...missingScope, maxBytes: 10, maxEvents: 1 }),
    ).resolves.toEqual({ kind: "missing" });

    const scope = {
      ...missingScope,
      sessionId: "oversized-raw-delta",
      sessionKey: "agent:main:oversized-raw-delta",
    };
    await appendTranscriptEvent(scope, { id: "large", text: "x".repeat(200), type: "custom" });
    const blocked = await readSessionTranscriptRawDelta({
      ...scope,
      cursor: "not-a-cursor",
      maxBytes: 10,
      maxEvents: 1,
    });
    expect(blocked).toMatchObject({ kind: "reset", reason: "invalid_cursor" });
    await expect(
      readSessionTranscriptRawDelta({
        ...scope,
        cursor: "",
        maxBytes: 10,
        maxEvents: 1,
      }),
    ).resolves.toMatchObject({ kind: "reset", reason: "invalid_cursor" });
    if (blocked.kind !== "reset") {
      throw new Error("expected invalid cursor reset");
    }
    const beyondFrontierCursor = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(blocked.cursor, "base64url").toString("utf8")) as object),
        lastSeq: 1,
      }),
      "utf8",
    ).toString("base64url");
    await expect(
      readSessionTranscriptRawDelta({
        ...scope,
        cursor: beyondFrontierCursor,
        maxBytes: 10,
        maxEvents: 1,
      }),
    ).resolves.toMatchObject({ kind: "reset", reason: "invalid_cursor" });
    const unsafeCursor = Buffer.from(
      JSON.stringify({
        agentId: scope.agentId,
        generation: "untrusted",
        lastSeq: 1e100,
        sessionId: scope.sessionId,
        version: 1,
      }),
      "utf8",
    ).toString("base64url");
    await expect(
      readSessionTranscriptRawDelta({
        ...scope,
        cursor: unsafeCursor,
        maxBytes: 10,
        maxEvents: 1,
      }),
    ).resolves.toMatchObject({ kind: "reset", reason: "invalid_cursor" });

    const bounded = await readSessionTranscriptRawDelta({
      ...scope,
      cursor: blocked.cursor,
      maxBytes: 10,
      maxEvents: 1,
    });
    expect(bounded).toMatchObject({
      kind: "page",
      events: [],
      hasMore: true,
      requiredBytes: expect.any(Number),
      serializedBytes: 0,
    });
    if (bounded.kind !== "page" || bounded.requiredBytes === undefined) {
      throw new Error("expected oversized event metadata");
    }

    const retried = await readSessionTranscriptRawDelta({
      ...scope,
      cursor: bounded.cursor,
      maxBytes: bounded.requiredBytes,
      maxEvents: 1,
    });
    expect(retried).toMatchObject({
      kind: "page",
      events: [{ event: { id: "large", text: "x".repeat(200), type: "custom" }, seq: 0 }],
      hasMore: false,
      serializedBytes: bounded.requiredBytes,
    });

    const otherScope = {
      ...scope,
      sessionId: "other-raw-delta",
      sessionKey: "agent:main:other-raw-delta",
    };
    await appendTranscriptEvent(otherScope, { id: "other", type: "custom" });
    await expect(
      readSessionTranscriptRawDelta({
        ...otherScope,
        cursor: retried.kind === "page" ? retried.cursor : "",
        maxBytes: 1_000,
        maxEvents: 1,
      }),
    ).resolves.toMatchObject({ kind: "reset", reason: "scope_mismatch" });
  });

  it("projects only visible transcript message entries with read-order metadata", async () => {
    const scope = transcriptScope("visible-projection-session");

    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const root = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: {
        role: "user",
        content: "root prompt",
        idempotencyKey: "root-user",
      },
      now: 1_000,
    });
    const inactive = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: {
        role: "assistant",
        content: "inactive answer",
        idempotencyKey: "inactive-assistant",
      },
      parentId: root?.messageId,
      now: 2_000,
    });
    const active = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: {
        role: "assistant",
        content: "active answer",
        idempotencyKey: "active-assistant",
      },
      parentId: root?.messageId,
      now: 3_000,
    });
    if (!root || !inactive || !active) {
      throw new Error("expected projected transcript setup messages");
    }
    await appendTranscriptEvent(scope, {
      type: "label",
      id: "label-1",
      parentId: active.messageId,
      value: "non-message metadata",
    });
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "select-active",
      parentId: inactive.messageId,
      targetId: active.messageId,
    });

    await expect(readVisibleSessionTranscriptMessageEntries(scope)).resolves.toEqual([
      {
        entryId: root.messageId,
        parentId: null,
        seq: 2,
        message: expect.objectContaining({
          role: "user",
          content: "root prompt",
          idempotencyKey: "root-user",
        }),
        role: "user",
        createdAt: "1970-01-01T00:00:01.000Z",
        idempotencyKey: "root-user",
      },
      {
        entryId: active.messageId,
        parentId: root.messageId,
        seq: 4,
        message: expect.objectContaining({
          role: "assistant",
          content: "active answer",
          idempotencyKey: "active-assistant",
        }),
        role: "assistant",
        createdAt: "1970-01-01T00:00:03.000Z",
        idempotencyKey: "active-assistant",
      },
    ]);
  });

  it("binds scoped reads to the SQLite transcript without exposing the legacy locator", async () => {
    const scope = {
      ...transcriptScope("active-session"),
      sessionFile: path.join(tempDir, "active-session.jsonl"),
    };
    const event = { id: "event-active", type: "metadata" };

    await upsertSessionEntryCore(scope, {
      sessionFile: path.join(tempDir, "store-default.jsonl"),
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptEvent(scope, event);

    const target = await resolveSessionTranscriptTarget(scope);

    expect(target).toEqual({
      agentId: "main",
      memoryKey: "transcript:main:active-session",
      sessionId: "active-session",
      sessionKey: "agent:main:main",
      targetKind: "runtime-session",
    });
    expect(target).not.toHaveProperty("sessionFile");
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([event]);
    expect(fs.existsSync(scope.sessionFile)).toBe(false);
  });

  it("publishes internal updates for SQLite transcript identity", async () => {
    const scope = {
      ...transcriptScope("publish-session"),
      sessionFile: path.join(tempDir, "publish-target.jsonl"),
    };
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    const internalUpdates: unknown[] = [];
    const offInternal = transcriptEvents.onInternalSessionTranscriptUpdate((update) => {
      internalUpdates.push(update);
    });

    try {
      await publishSessionTranscriptUpdateByIdentity({
        ...scope,
        update: {
          agentId: "stale-agent",
          messageId: "message-from-direct-publish",
          sessionKey: "agent:stale:other",
        },
      });
    } finally {
      offInternal();
    }

    expect(emitSpy).toHaveBeenCalledWith({
      agentId: "main",
      messageId: "message-from-direct-publish",
      sessionId: "publish-session",
      sessionKey: "agent:main:main",
      target: {
        agentId: "main",
        sessionId: "publish-session",
        sessionKey: "agent:main:main",
        storePath: path.join(tempDir, "openclaw-agent.sqlite"),
      },
    });
    expect(internalUpdates).toEqual([
      {
        agentId: "main",
        messageId: "message-from-direct-publish",
        sessionId: "publish-session",
        sessionKey: "agent:main:main",
        target: {
          agentId: "main",
          sessionId: "publish-session",
          sessionKey: "agent:main:main",
          storePath: path.join(tempDir, "openclaw-agent.sqlite"),
        },
      },
    ]);
  });

  it("locks read and append helpers to one scoped transcript target", async () => {
    const scope = {
      ...transcriptScope("locked-session"),
      sessionFile: path.join(tempDir, "locked-target.jsonl"),
    };

    const target = await withSessionTranscriptWriteLock(scope, async (locked) => {
      expect(await locked.readEvents()).toEqual([]);
      expect(locked).not.toHaveProperty("appendMessageWithMessageSequence");
      expect(locked).not.toHaveProperty("readMessageFacts");
      await locked.appendMessage({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "locked" }],
          timestamp: 1,
        },
      });
      return locked.target;
    });

    expect(target).toMatchObject({
      sessionId: "locked-session",
      targetKind: "runtime-session",
    });
    expect(target).not.toHaveProperty("sessionFile");
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
    ]);
  });

  it("publishes queued locked updates after callback appends are visible", async () => {
    const scope = {
      ...transcriptScope("queued-publish-session"),
      sessionFile: path.join(tempDir, "queued-publish-target.jsonl"),
    };
    let callbackCompleted = false;
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    const result = await withSessionTranscriptWriteLock(scope, async (locked) => {
      await locked.appendMessage({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "queued publish" }],
          timestamp: 1,
        },
      });
      await locked.publishUpdate({
        messageId: "message-from-callback",
      });
      expect(emitSpy).not.toHaveBeenCalled();
      callbackCompleted = true;
      return "complete";
    });

    expect(result).toBe("complete");
    expect(callbackCompleted).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith({
      agentId: "main",
      messageId: "message-from-callback",
      sessionId: "queued-publish-session",
      sessionKey: "agent:main:main",
      target: {
        agentId: "main",
        sessionId: "queued-publish-session",
        sessionKey: "agent:main:main",
        storePath: path.join(tempDir, "openclaw-agent.sqlite"),
      },
    });
    await expect(readSessionTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({
        message: expect.objectContaining({ role: "assistant" }),
      }),
    ]);
  });

  it("round-trips encoded memory hit keys with opaque session ids", () => {
    const key = formatSessionTranscriptMemoryHitKey({
      agentId: "SECONDARY",
      sessionId: "my-plugin:task/1",
    });

    expect(key).toBe("transcript:secondary:my-plugin%3Atask%2F1");
    expect(parseSessionTranscriptMemoryHitKey(key)).toEqual({
      agentId: "secondary",
      key,
      sessionId: "my-plugin:task/1",
    });
  });
});
