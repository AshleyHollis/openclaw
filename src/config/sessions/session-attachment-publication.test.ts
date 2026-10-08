import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import {
  appendSessionTranscriptMessageByIdentityStrict,
  createSessionTranscriptVisibleMessageDigest,
  prepareSessionTranscriptSourceAdmission,
  readSessionTranscriptVisibleMessageDelta,
  type PreparedSessionTranscriptSourceAdmission,
} from "../../plugin-sdk/session-transcript-runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "../../plugin-sdk/sqlite-runtime-testing.js";
import { resolveOpenClawAgentSqlitePath } from "../../plugin-sdk/sqlite-runtime.js";
import { publishSessionTranscriptSourceAdmissionEffect } from "./session-transcript-source-admission.js";

const sources: Array<{ directory: string; capability: PreparedSessionTranscriptSourceAdmission }> =
  [];
afterEach(async () => {
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

it("executes the synchronous host effect while its actual native source writer is excluded", async () => {
  const { capability, sourcePath } = await sourceFixture();
  let effects = 0;
  await publishSessionTranscriptSourceAdmissionEffect(
    capability,
    () => {
      expect(writerBusy(sourcePath)).toBe(true);
      effects++;
    },
    () => {},
  );
  expect(effects).toBe(1);
  expect(writerBusy(sourcePath)).toBe(false);
  await expect(
    publishSessionTranscriptSourceAdmissionEffect(
      capability,
      () => {
        effects++;
      },
      () => {},
    ),
  ).rejects.toMatchObject({ effectState: "not-entered" });
  expect(effects).toBe(1);
});

it("reports source retirement before entry even when the authority throws undefined", async () => {
  const { capability } = await sourceFixture();
  let effects = 0;
  await expect(
    publishSessionTranscriptSourceAdmissionEffect(
      capability,
      () => {
        effects++;
      },
      () => {
        // oxlint-disable-next-line typescript/only-throw-error -- Undefined authority failure must still prevent effect entry.
        throw undefined;
      },
    ),
  ).rejects.toMatchObject({ effectState: "not-entered" });
  expect(effects).toBe(0);
});

it("refuses an async effect before invoking it and releases its source", async () => {
  const { capability, sourcePath } = await sourceFixture();
  let effects = 0;
  await expect(
    publishSessionTranscriptSourceAdmissionEffect(
      capability,
      // oxlint-disable-next-line typescript/no-misused-promises -- Invalid async effect must be refused without invocation.
      async () => {
        effects++;
      },
      () => {},
    ),
  ).rejects.toMatchObject({ effectState: "not-entered" });
  expect(effects).toBe(0);
  expect(writerBusy(sourcePath)).toBe(false);
});

it("preserves entered outcome and runs synchronous owner rollback inside exclusion", async () => {
  const { capability, sourcePath } = await sourceFixture();
  let rollback = false;
  await expect(
    publishSessionTranscriptSourceAdmissionEffect(
      capability,
      () => {
        try {
          throw new Error("Fictional file effect failed");
        } finally {
          expect(writerBusy(sourcePath)).toBe(true);
          rollback = true;
        }
      },
      () => {},
    ),
  ).rejects.toMatchObject({ effectState: "entered" });
  expect(rollback).toBe(true);
  expect(writerBusy(sourcePath)).toBe(false);
});
