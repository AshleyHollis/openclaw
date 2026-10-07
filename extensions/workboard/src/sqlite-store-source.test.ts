import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentityStrict,
  createSessionTranscriptVisibleMessageDigest,
  prepareSessionTranscriptSourceAdmission,
  readSessionTranscriptVisibleMessageDelta,
  type PreparedSessionTranscriptSourceAdmission,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
  observeSqliteWorkerAdmissionForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, expect, it } from "vitest";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

const sources: Array<{ directory: string; capability: PreparedSessionTranscriptSourceAdmission }> =
  [];
const observers: Array<ReturnType<typeof observeSqliteWorkerAdmissionForTest>> = [];
afterEach(async () => {
  for (const observer of observers.splice(0)) {
    observer.restore();
  }
  for (const source of sources.splice(0)) {
    await source.capability.close();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    fs.rmSync(source.directory, { recursive: true, force: true });
  }
});

async function sourceFixture(assertNativeCurrent: () => void = () => {}) {
  // openclaw-temp-dir: allow native owners close before removal.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-source-"));
  const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:workboard-source",
    sessionId: "source-one",
    env,
  };
  await upsertSessionEntry({ ...scope, entry: { sessionId: scope.sessionId, updatedAt: 1 } });
  const appended = await appendSessionTranscriptMessageByIdentityStrict({
    ...scope,
    eventId: "source-message",
    message: { role: "user", content: "Fictional source" },
  });
  expect(appended.kind).toBe("result");
  const page = await readSessionTranscriptVisibleMessageDelta({
    ...scope,
    maxMessages: 1,
    maxBytes: 100_000,
  });
  if (page.kind !== "page" || !page.entries[0]) {
    throw new Error("Canonical source fixture is unavailable");
  }
  const selection = {
    agentId: scope.agentId,
    sessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
    entryId: page.entries[0].entryId,
    generation: page.generation,
    digest: createSessionTranscriptVisibleMessageDigest(page.entries[0]),
  };
  const capability = await prepareSessionTranscriptSourceAdmission(selection, {
    env,
    assertCurrent: assertNativeCurrent,
  });
  sources.push({ directory, capability });
  return { scope, capability, sourcePath: resolveOpenClawAgentSqlitePath(scope) };
}

function writerBusy(databasePath: string): boolean {
  const peer = new DatabaseSync(databasePath);
  try {
    peer.exec("PRAGMA busy_timeout=0");
    try {
      peer.exec("BEGIN IMMEDIATE; ROLLBACK");
      return false;
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== 5) {
        throw error;
      }
      return true;
    }
  } finally {
    peer.close();
  }
}

function assertForeignWriterExcluded(databasePath: string) {
  const peer = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout=0');
    try { db.exec('BEGIN IMMEDIATE; ROLLBACK'); process.exitCode=2; }
    catch(error) { if(error.errcode!==5) throw error; }
    finally { db.close(); }
  `,
      databasePath,
    ],
    { encoding: "utf8" },
  );
  expect(peer.error).toBeUndefined();
  expect(peer.status, peer.stderr).toBe(0);
}

it("holds a source-bound native writer lock through actual Workboard transaction and commit admission", async () => {
  const { capability, sourcePath } = await sourceFixture();
  const { store, stores, dbPath } = createWorkboardSqliteTestHarness();
  await stores.ready;
  const admission = observeSqliteWorkerAdmissionForTest();
  observers.push(admission);
  const admittedStages = new Set<string>();
  const card = await store.create(
    { title: "Fictional accepted card", idempotencyKey: "source-create" },
    undefined,
    () => {
      const stage = admission.currentRequest?.stage;
      if ((stage === "transaction" || stage === "commit") && writerBusy(dbPath)) {
        admittedStages.add(stage);
        assertForeignWriterExcluded(sourcePath);
        expect(writerBusy(sourcePath)).toBe(true);
      }
    },
    capability,
  );
  expect(admittedStages).toEqual(new Set(["transaction", "commit"]));
  await expect(store.get(card.id)).resolves.toEqual(card);
  expect(writerBusy(sourcePath)).toBe(false);
  await expect(
    store.create({ title: "Retained capability" }, undefined, () => {}, capability),
  ).rejects.toThrow();
  await expect(store.list()).resolves.toHaveLength(1);
});

it("rolls back the real destination commit when captured authority retires at commit admission", async () => {
  const { capability, sourcePath } = await sourceFixture();
  const { store, stores, dbPath } = createWorkboardSqliteTestHarness();
  await stores.ready;
  const admission = observeSqliteWorkerAdmissionForTest();
  observers.push(admission);
  const admittedStages = new Set<string>();
  await expect(
    store.create(
      { title: "Fictional refused card" },
      undefined,
      () => {
        const stage = admission.currentRequest?.stage;
        if ((stage === "transaction" || stage === "commit") && writerBusy(dbPath)) {
          admittedStages.add(stage);
          expect(writerBusy(sourcePath)).toBe(true);
          if (stage === "commit") {
            throw new Error("Fictional invocation retired");
          }
        }
      },
      capability,
    ),
  ).rejects.toThrow("SQLite transaction admission was refused");
  expect(admittedStages).toEqual(new Set(["transaction", "commit"]));
  await expect(store.list()).resolves.toEqual([]);
  expect(writerBusy(sourcePath)).toBe(false);
  expect(writerBusy(dbPath)).toBe(false);
});

it("refuses a replaced Session after preparation without publishing a card", async () => {
  const { scope, capability } = await sourceFixture();
  await patchSessionEntry({ ...scope, update: () => ({ sessionId: "source-replacement" }) });
  const { store, stores } = createWorkboardSqliteTestHarness();
  await stores.ready;
  await expect(
    store.create({ title: "Fictional stale card" }, undefined, () => {}, capability),
  ).rejects.toThrow();
  await expect(store.list()).resolves.toEqual([]);
});

it("consumes a capability whose captured native authority retires before worker dispatch", async () => {
  let current = true;
  const { capability, sourcePath } = await sourceFixture(() => {
    if (!current) {
      throw new Error("Fictional source authority retired");
    }
  });
  const { store, stores } = createWorkboardSqliteTestHarness();
  await stores.ready;
  current = false;
  await expect(
    store.create({ title: "Fictional retired source" }, undefined, () => {}, capability),
  ).rejects.toThrow("Fictional source authority retired");
  current = true;
  await expect(
    store.create({ title: "Fictional retained source" }, undefined, () => {}, capability),
  ).rejects.toThrow("already consumed");
  await expect(store.list()).resolves.toEqual([]);
  expect(writerBusy(sourcePath)).toBe(false);
});

it("revokes transferred source custody when create validation refuses before dispatch", async () => {
  const { capability } = await sourceFixture();
  const { store, stores } = createWorkboardSqliteTestHarness();
  await stores.ready;
  await expect(store.create({ title: "" }, undefined, () => {}, capability)).rejects.toThrow();
  await expect(
    store.create({ title: "Fictional retained source" }, undefined, () => {}, capability),
  ).rejects.toThrow("closed");
  await expect(store.list()).resolves.toEqual([]);
});

it("revokes transferred source custody when the store refuses before entering mutation authority", async () => {
  const { capability } = await sourceFixture();
  const refused = createWorkboardSqliteTestHarness();
  await refused.stores.ready;
  await refused.store.close();
  await expect(
    refused.store.create({ title: "Fictional closed owner" }, undefined, () => {}, capability),
  ).rejects.toThrow("closed");
  const next = createWorkboardSqliteTestHarness();
  await next.stores.ready;
  await expect(
    next.store.create({ title: "Fictional retained source" }, undefined, () => {}, capability),
  ).rejects.toThrow("closed");
  await expect(next.store.list()).resolves.toEqual([]);
});

it("refuses destination file replacement at transaction admission before card commit", async () => {
  const { capability } = await sourceFixture();
  const { store, stores, dbPath } = createWorkboardSqliteTestHarness();
  await stores.ready;
  const retainedPath = `${dbPath}.retained`;
  let replaced = false;
  try {
    await expect(
      store.create(
        { title: "Fictional replaced destination" },
        undefined,
        () => {
          if (!replaced && writerBusy(dbPath)) {
            fs.renameSync(dbPath, retainedPath);
            fs.copyFileSync(retainedPath, dbPath);
            replaced = true;
          }
        },
        capability,
      ),
    ).rejects.toThrow("destination changed");
    expect(replaced).toBe(true);
  } finally {
    if (replaced) {
      fs.rmSync(dbPath);
      fs.renameSync(retainedPath, dbPath);
    }
  }
  await expect(store.list()).resolves.toEqual([]);
});
