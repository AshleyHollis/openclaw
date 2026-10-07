import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { appendTranscriptEvent, persistSessionTranscriptTurn } from "./session-accessor.js";
import { readSessionTranscriptBoundedMessageTailPage } from "./session-accessor.sqlite-active-events.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import type { SessionTranscriptSourceLockFacts } from "./session-accessor.sqlite-source-lock.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import {
  createSessionTranscriptVisibleMessageDigest,
  projectVisibleMessageEntry,
} from "./session-transcript-visible-message.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let withSourceLock: typeof import("./session-accessor.sqlite-source-lock.js").withSessionTranscriptSourceLock;
let database: OpenClawAgentDatabase;
let facts: SessionTranscriptSourceLockFacts;

beforeAll(async () => {
  // This unit exercises real SQLite owners; real worker dispatch is integration qualification.
  vi.doMock("node:worker_threads", async (original) => ({
    ...(await original<typeof import("node:worker_threads")>()),
    isMainThread: false,
  }));
  ({ withSessionTranscriptSourceLock: withSourceLock } =
    await import("./session-accessor.sqlite-source-lock.js"));
});

beforeEach(async () => {
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-source-lock-") },
    sessionKey: "agent:main:source-lock",
    sessionId: "source-lock-incarnation",
  };
  await persistSessionTranscriptTurn(scope, {
    messages: [transcriptMessage("source", null, { role: "user", content: "original" })],
    touchSessionEntry: false,
  });
  runOpenClawAgentWriteTransaction(
    (owner) =>
      writeSessionEntry(owner, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 }),
    scope,
  );
  await waitForSessionTranscriptIndexReconcile(scope);
  database = openOpenClawAgentDatabase(scope);
  const page = readSessionTranscriptBoundedMessageTailPage(scope, {
    maxMessages: 1,
    maxBytes: 1024 * 1024,
    offset: 0,
  });
  const source = page.events[0];
  if (!source || !page.snapshot.generation) {
    throw new Error("Canonical source fixture is unavailable");
  }
  const entry = projectVisibleMessageEntry({ ...source, parentId: null })[0];
  if (!entry) {
    throw new Error("Canonical source fixture has no visible message");
  }
  facts = {
    scope: { ...scope, path: database.path },
    identity: readDatabasePathIdentitySync(database.path),
    entryId: entry.entryId,
    generation: page.snapshot.generation,
    digest: createSessionTranscriptVisibleMessageDigest(entry),
  };
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("holds native source exclusion through the exact synchronous effect against a second process", () => {
  let calls = 0;
  const value = withSourceLock(
    database,
    facts,
    () => {},
    (entry) => {
      calls++;
      expect(entry.entryId).toBe("source");
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout=0');
      try { db.exec('BEGIN IMMEDIATE'); process.exitCode = 2; }
      catch (error) { if (error.errcode !== 5) throw error; }
      finally { db.close(); }
    `,
          database.path,
        ],
        { encoding: "utf8" },
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      return "accepted";
    },
  );
  expect(value).toBe("accepted");
  expect(calls).toBe(1);
  const peer = new DatabaseSync(database.path);
  try {
    peer.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK");
  } finally {
    peer.close();
  }
});

it.each(["incarnation", "generation", "entry", "digest"] as const)(
  "refuses stale %s before the effect",
  (changed) => {
    const stale = {
      ...facts,
      ...(changed === "incarnation" ? { scope: { ...facts.scope, sessionId: "replaced" } } : {}),
      ...(changed === "generation" ? { generation: "replaced" } : {}),
      ...(changed === "entry" ? { entryId: "removed" } : {}),
      ...(changed === "digest" ? { digest: "sha256-public-message-v1:changed" } : {}),
    };
    const effect = vi.fn();
    expect(() => withSourceLock(database, stale, () => {}, effect)).toThrow();
    expect(effect).not.toHaveBeenCalled();
    expect(database.db.isTransaction).toBe(false);
  },
);

it("rejects nested admission and Promise effects, and releases after effect failure", () => {
  const asyncEffect = vi.fn();
  expect(() =>
    withSourceLock(
      database,
      facts,
      () => {},
      async () => asyncEffect(),
    ),
  ).toThrow("synchronous");
  expect(asyncEffect).not.toHaveBeenCalled();
  expect(() =>
    withSourceLock(
      database,
      facts,
      () => {},
      () =>
        withSourceLock(
          database,
          facts,
          () => {},
          () => undefined,
        ),
    ),
  ).toThrow("existing transaction");
  expect(database.db.isTransaction).toBe(false);
  expect(() =>
    withSourceLock(
      database,
      facts,
      () => {},
      () => Promise.resolve(),
    ),
  ).toThrow("synchronous");
  expect(database.db.isTransaction).toBe(false);
  expect(() =>
    withSourceLock(
      database,
      facts,
      () => {},
      () => Promise.reject(new Error("invalid async effect")),
    ),
  ).toThrow("synchronous");
  expect(database.db.isTransaction).toBe(false);
  expect(() =>
    withSourceLock(
      database,
      facts,
      () => {},
      () => {
        throw new Error("effect failed");
      },
    ),
  ).toThrow("effect failed");
  expect(database.db.isTransaction).toBe(false);
});

it("rechecks retired owner authority after entering source admission", () => {
  let checks = 0;
  const effect = vi.fn();
  expect(() =>
    withSourceLock(
      database,
      facts,
      () => {
        if (++checks === 2) {
          throw new Error("retired source owner");
        }
      },
      effect,
    ),
  ).toThrow("retired source owner");
  expect(effect).not.toHaveBeenCalled();
  expect(database.db.isTransaction).toBe(false);
});

it("refuses an active-path entry hidden by a committed reset", async () => {
  await appendTranscriptEvent(facts.scope, {
    type: "reset",
    id: "hide-source",
    parentId: facts.entryId,
    timestamp: "2026-10-07T00:00:00.000Z",
    reason: "new",
  });
  await waitForSessionTranscriptIndexReconcile(facts.scope);
  const effect = vi.fn();
  expect(() => withSourceLock(database, facts, () => {}, effect)).toThrow();
  expect(effect).not.toHaveBeenCalled();
  expect(database.db.isTransaction).toBe(false);
});
