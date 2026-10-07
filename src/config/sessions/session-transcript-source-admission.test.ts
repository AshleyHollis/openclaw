import { expect, it } from "vitest";
import {
  prepareSessionTranscriptSourceAdmission,
  runSessionTranscriptSourceAdmissionOperation,
  type PreparedSessionTranscriptSourceAdmission,
  type SessionTranscriptSourceSelection,
} from "./session-transcript-source-admission.js";

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
      assertCurrent() {
        return Promise.resolve();
      },
    }),
  ).rejects.toThrow("must be synchronous");
});
