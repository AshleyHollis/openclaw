import { describe, expect, it } from "vitest";
import {
  createSessionTranscriptVisibleMessageDigest,
  projectVisibleMessageEntry,
} from "./session-transcript-visible-message.js";

function project(message: unknown) {
  const [entry] = projectVisibleMessageEntry({
    event: { type: "message", id: "accepted", message, timestamp: "2026-10-07T00:00:00Z" },
    parentId: "previous",
    seq: 2,
  });
  if (!entry) {
    throw new Error("Fixture message was not visible");
  }
  return entry;
}

describe("public visible-message source digest", () => {
  it("projects persisted content without changing storage redaction or public identity", () => {
    const message = { role: "user", content: "[REDACTED]", timestamp: 1 };
    expect(project(message)).toEqual({
      entryId: "accepted",
      parentId: "previous",
      seq: 2,
      message,
      role: "user",
      createdAt: "2026-10-07T00:00:00Z",
    });
  });

  it("versions canonical message bytes independently of object key order and read metadata", () => {
    const first = project({ role: "user", content: "Track this", timestamp: 1 });
    const reordered = project({ timestamp: 1, content: "Track this", role: "user" });
    const digest = createSessionTranscriptVisibleMessageDigest(first);
    expect(digest).toMatch(/^sha256-public-message-v1:[a-f0-9]{64}$/);
    expect(createSessionTranscriptVisibleMessageDigest(reordered)).toBe(digest);
    expect(createSessionTranscriptVisibleMessageDigest({ ...first, seq: 99, parentId: null })).toBe(
      digest,
    );
    expect(
      createSessionTranscriptVisibleMessageDigest(
        project({
          role: "user",
          content: "Changed acceptance",
          timestamp: 1,
        }),
      ),
    ).not.toBe(digest);
  });

  it("does not manufacture a visible message from control events or missing identities", () => {
    for (const event of [
      { type: "compaction", id: "accepted" },
      { type: "message", message: { role: "user", content: "Track this" } },
      { type: "message", id: "accepted", message: { content: "Track this" } },
    ]) {
      expect(projectVisibleMessageEntry({ event, parentId: null, seq: 1 })).toEqual([]);
    }
  });
});
