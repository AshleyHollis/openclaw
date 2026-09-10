import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  prepareOfflineSessionSnapshot,
  publishPreparedOfflineSessionSnapshot,
} from "../../scripts/lib/offline-session-preparation.mts";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  createEvent,
  createLegacyDatabaseFixture,
} from "../infra/state-migrations.media-persistence.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createFixturePreparationApproval } from "./offline-session-preparation.test-support.js";

const originalNativeConfig = getFsSafeNativeConfig();
beforeAll(() => configureFsSafeNative({ mode: "require" }));
afterAll(() => configureFsSafeNative(originalNativeConfig));

it.each([
  { name: "dirty-small", count: 1, padding: false, leading: false, needsRebuild: 0 },
  { name: "dirty-large", count: 1, padding: false, leading: false, needsRebuild: 1 },
  { name: "crossing-final-batch", count: 64, padding: true, leading: false, needsRebuild: 1 },
  { name: "crossing-next-batch", count: 65, padding: true, leading: false, needsRebuild: 0 },
  { name: "crossing-global-batch", count: 64, padding: true, leading: true, needsRebuild: 0 },
])(
  "prepares native transcript projections without inventing completion ($name)",
  async (scenario) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-projection-"));
    const originalRoot = path.join(root, "original");
    const privateStateDir = path.join(root, "preparation");
    const targetPath = path.join(root, "sessions.sqlite");
    try {
      const events = Array.from({ length: scenario.count }, (_, index) =>
        createEvent({
          id: `event-${index}`,
          parentId: index === 0 ? null : `event-${index - 1}`,
          timestamp: 1000 + index,
          message: {
            role: "user",
            content:
              scenario.name === "dirty-large"
                ? "x".repeat(4 * 1024 * 1024)
                : `Kept message ${index}.`,
            MediaPath: "/fictional/bill.pdf",
          },
        }),
      );
      const sourcePath = createLegacyDatabaseFixture({
        env: { OPENCLAW_STATE_DIR: originalRoot },
        eventsBySession: {
          ...(scenario.leading
            ? {
                "session-0": [
                  createEvent({
                    id: "leading",
                    parentId: null,
                    timestamp: 1,
                    message: { role: "user", content: "Unchanged leading Session." },
                  }),
                ],
              }
            : {}),
          "session-a": events,
        },
      });
      await closeOpenClawAgentDatabasesAsync(originalRoot);
      closeOpenClawStateDatabase();
      const source = openNodeSqliteDatabase(sourcePath);
      try {
        source.exec(
          "UPDATE session_transcript_index_state SET needs_rebuild=1 WHERE session_id='session-a'",
        );
        source.exec(
          "UPDATE session_transcript_fts SET text='Stale index.' WHERE session_id='session-a'",
        );
        if (scenario.padding) {
          source
            .prepare(
              "UPDATE transcript_events SET event_json=? || event_json WHERE session_id='session-a'",
            )
            .run(" ".repeat(65_536));
        }
      } finally {
        source.close();
      }
      const originalBytes = await fs.readFile(sourcePath);
      const preparation = {
        sourcePath,
        targetPath,
        agentId: "main",
        privateStateDir,
      };
      const approved = {
        ...preparation,
        ...(await createFixturePreparationApproval(preparation)),
      };
      const staged = await prepareOfflineSessionSnapshot(approved);
      await publishPreparedOfflineSessionSnapshot({ ...approved, ...staged });
      // The published SQLite file is the preparation API's output, not private implementation state.
      const prepared = openNodeSqliteDatabase(targetPath, { readOnly: true });
      try {
        expect(
          prepared
            .prepare(
              "SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id='session-a'",
            )
            .get(),
        ).toEqual({ needs_rebuild: scenario.needsRebuild });
        const indexed = prepared
          .prepare(
            "SELECT text FROM session_transcript_fts WHERE session_id='session-a' AND message_id='event-0'",
          )
          .get();
        expect(indexed?.text).toBe(
          scenario.needsRebuild === 1 ? "Stale index." : "Kept message 0.",
        );
        expect(
          prepared
            .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id='session-a'")
            .get(),
        ).toEqual({ count: scenario.count });
        if (scenario.leading) {
          expect(
            prepared
              .prepare("SELECT text FROM session_transcript_fts WHERE session_id='session-0'")
              .get(),
          ).toEqual({ text: "Unchanged leading Session." });
        }
      } finally {
        prepared.close();
      }
      expect((await fs.readFile(sourcePath)).equals(originalBytes)).toBe(true);
      await expect(fs.stat(privateStateDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawStateDatabase();
      await fs.rm(root, { recursive: true });
    }
  },
);
