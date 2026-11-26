import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it } from "vitest";
import {
  appendSessionTranscriptMessageByIdentity,
  createSessionTranscriptVisibleMessageDigest,
  prepareSessionTranscriptSourceAdmission,
  readSessionTranscriptVisibleMessageDelta,
} from "../../plugin-sdk/session-transcript-runtime.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { bindSessionTranscriptStoreScope } from "./session-accessor.transcript-target.js";
import {
  publishSessionTranscriptSourceAdmissionEffect,
  runSessionTranscriptSourceAdmissionOperation,
  type PreparedSessionTranscriptSourceAdmission,
  type SessionTranscriptSourceSelection,
} from "./session-transcript-source-admission.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-source-admission-");

const selection: SessionTranscriptSourceSelection = {
  agentId: "main",
  sessionKey: "agent:main:source",
  sessionId: "source-one",
  entryId: "message-one",
  generation: "generation-one",
  digest: `sha256-public-message-v1:${"1".repeat(64)}`,
};

it("refuses JSON-shaped authority before any native source lookup", async () => {
  await expect(
    prepareSessionTranscriptSourceAdmission(selection, JSON.parse('{"assertCurrent":true}')),
  ).rejects.toThrow("captured native authority");
});

it("preserves the native incognito re-persistence prohibition", async () => {
  await expect(
    prepareSessionTranscriptSourceAdmission(
      { ...selection, sessionKey: "agent:main:dashboard:incognito-source" },
      {
        assertCurrent() {
          throw new Error("Must not authorize protected source");
        },
      },
    ),
  ).rejects.toThrow("Incognito transcripts cannot be re-persisted");
});

it("refuses a foreign agent identity before native source lookup", async () => {
  await expect(
    prepareSessionTranscriptSourceAdmission(
      { ...selection, agentId: "foreign" },
      {
        assertCurrent() {
          throw new Error("Must not authorize foreign source");
        },
      },
    ),
  ).rejects.toThrow("does not belong to its exact agent");
});

it("requires the declared digest version before native source lookup", async () => {
  await expect(
    prepareSessionTranscriptSourceAdmission(
      { ...selection, digest: `sha256:${"1".repeat(64)}` },
      {
        assertCurrent() {
          throw new Error("Must not authorize unsupported source");
        },
      },
    ),
  ).rejects.toThrow("invalid or unsupported");
});

it("refuses retired authenticated invocation before native source lookup", async () => {
  await expect(
    prepareSessionTranscriptSourceAdmission(selection, {
      assertCurrent(source) {
        expect(source).toEqual(selection);
        throw new Error("Authenticated invocation retired");
      },
    }),
  ).rejects.toThrow("Authenticated invocation retired");
});

it("rejects a serialized admission descriptor without invoking its publisher", async () => {
  const fabricated = JSON.parse('{"close":true}') as PreparedSessionTranscriptSourceAdmission;
  await expect(
    runSessionTranscriptSourceAdmissionOperation<{
      publish: { input: undefined; output: void };
    }>(
      fabricated,
      { moduleUrl: new URL("file:///never-load-source-worker.js"), input: {} },
      { type: "publish", input: undefined },
      () => {
        throw new Error("Must not publish");
      },
    ),
  ).rejects.toThrow("absent or already consumed");
});

it("refuses async native authority before invoking its source lookup", async () => {
  let invoked = false;
  await expect(
    prepareSessionTranscriptSourceAdmission(selection, {
      // oxlint-disable-next-line typescript/no-misused-promises -- Invalid async authority must not invoke or look up the native source.
      async assertCurrent() {
        invoked = true;
      },
    }),
  ).rejects.toThrow("captured native authority");
  expect(invoked).toBe(false);
});

it("refuses a native authority returning a promise before source lookup", async () => {
  await expect(
    prepareSessionTranscriptSourceAdmission(selection, {
      // oxlint-disable-next-line typescript/no-misused-promises -- Invalid Promise-returning authority proves synchronous refusal before source lookup.
      assertCurrent() {
        return Promise.resolve();
      },
    }),
  ).rejects.toThrow("must be synchronous");
});

it("publishes once under the selected worker lock and refuses retired authority", async () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: sessionDirs.make() };
  const config = {};
  const scope = bindSessionTranscriptStoreScope(
    { agentId: "main", sessionKey: "agent:main:retained-source", sessionId: "one", env },
    config,
  );
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await appendSessionTranscriptMessageByIdentity({
    ...scope,
    message: { role: "user", content: "exact retained source" },
  });
  const page = await readSessionTranscriptVisibleMessageDelta(scope);
  if (page.kind !== "page" || !page.entries[0]) {
    throw new Error("Expected an admitted source message");
  }
  const selected = {
    agentId: scope.agentId,
    sessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
    entryId: page.entries[0].entryId,
    generation: page.generation,
    digest: createSessionTranscriptVisibleMessageDigest(page.entries[0]),
  };
  let active = true;
  const authority = {
    config,
    env,
    assertCurrent() {
      if (!active) {
        throw new Error("Original source authority retired");
      }
    },
  };
  await expect(
    prepareSessionTranscriptSourceAdmission({ ...selected, digest: selection.digest }, authority),
  ).rejects.toThrow("Transcript source message changed");
  const prepared = await prepareSessionTranscriptSourceAdmission(selected, authority);
  const revoked = await prepareSessionTranscriptSourceAdmission(selected, authority);
  let publications = 0;
  const effect = () => {
    const peer = new DatabaseSync(resolveSessionTranscriptDatabasePath(scope));
    try {
      expect(() => peer.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE")).toThrow(/locked/iu);
    } finally {
      peer.close();
    }
    publications++;
  };
  try {
    await publishSessionTranscriptSourceAdmissionEffect(prepared, effect, () => {});
    await expect(
      publishSessionTranscriptSourceAdmissionEffect(prepared, effect, () => {}),
    ).rejects.toMatchObject({ effectState: "not-entered" });
    active = false;
    await expect(
      publishSessionTranscriptSourceAdmissionEffect(revoked, effect, () => {}),
    ).rejects.toMatchObject({ effectState: "not-entered" });
    expect(publications).toBe(1);
  } finally {
    await Promise.all([prepared.close(), revoked.close()]);
  }
});
