import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureMemoryChunkFtsSchema,
  ensureMemoryPathFtsSchema,
} from "../../packages/memory-host-sdk/src/host/memory-schema-fts.js";
import {
  prepareOfflineSessionSnapshot as prepareApprovedSnapshot,
  publishPreparedOfflineSessionSnapshot,
} from "../../scripts/lib/offline-session-preparation.mts";
import {
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  createEvent,
  createLegacyDatabaseFixture,
  readDatabaseSnapshot,
  writeArchive,
} from "../infra/state-migrations.media-persistence.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { withLegacySessionParticipantsSchema } from "../state/openclaw-agent-participants-migration.js";
import { sessionParticipantsSchemaSql } from "../state/openclaw-agent-session-participants-schema.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createFixturePreparationApproval } from "./offline-session-preparation.test-support.js";

const originalNativeConfig = getFsSafeNativeConfig();
beforeAll(() => configureFsSafeNative({ mode: "require" }));
afterAll(() => configureFsSafeNative(originalNativeConfig));
async function prepareOfflineSessionSnapshot(
  options: Parameters<typeof createFixturePreparationApproval>[0],
) {
  const approved = {
    ...options,
    ...(await createFixturePreparationApproval(options)),
  };
  const prepared = await prepareApprovedSnapshot(approved);
  return await publishPreparedOfflineSessionSnapshot({ ...approved, ...prepared });
}

const originalSchemaMutations: Record<string, string> = {
  "rejected-original-schema":
    "CREATE TABLE unclassified_history (content TEXT); INSERT INTO unclassified_history VALUES ('retain unknown history');",
  "rejected-original-column": "ALTER TABLE session_nodes ADD COLUMN unclassified_content TEXT;",
  "rejected-original-trigger":
    "CREATE TRIGGER unclassified_effect AFTER UPDATE ON session_nodes BEGIN DELETE FROM transcript_events; END;",
  "rejected-original-drifted-trigger":
    "DROP TRIGGER session_nodes_entry_valid_after_insert; CREATE TRIGGER session_nodes_entry_valid_after_insert AFTER INSERT ON session_nodes BEGIN DELETE FROM transcript_events; END;",
  "rejected-original-core-table": "DROP TABLE cache_entries;",
  "rejected-original-role": "UPDATE schema_meta SET role=' agent ';",
  "rejected-original-owner": "UPDATE schema_meta SET agent_id=' main ';",
  "rejected-original-markers": "UPDATE schema_meta SET schema_version=19;",
  "rejected-original-shadow":
    "CREATE TABLE memory_index_chunks_fts_data(id INTEGER PRIMARY KEY, block BLOB);",
  "rejected-retired-lease-shape": "CREATE TABLE state_leases (unclassified_content TEXT);",
};

describe("offline Session preparation", () => {
  it.each([
    "none",
    "plain",
    "zstd",
    "aggregate-stored-zstd",
    "invalid-utf8-archive",
    "lossy-plain",
    "lossy-zstd",
    "unchanged-plain",
    "unchanged-zstd",
    "nul-plain",
    "nul-zstd",
    "no-newline-plain",
    "no-newline-zstd",
    "isolated-cli",
    "rejected-media",
    "rejected-env",
    "symlink-archive",
    "hardlink-archive",
    "current-schema-media",
    "current-schema-lazy",
    "legacy-metadata",
    "legacy-lazy",
    ...Object.keys(originalSchemaMutations),
    "legacy-pre-additive",
    "current-pre-additive",
    "historical-source",
  ])("prepares or refuses original input safely (%s)", async (archiveMode) => {
    const withArchive = [
      "plain",
      "zstd",
      "invalid-utf8-archive",
      "lossy-plain",
      "lossy-zstd",
      "unchanged-plain",
      "unchanged-zstd",
      "nul-plain",
      "nul-zstd",
      "no-newline-plain",
      "no-newline-zstd",
    ].includes(archiveMode);
    const compressedArchive = archiveMode.endsWith("zstd");
    const unchangedArchive = archiveMode.startsWith("unchanged-");
    const noNewlineArchive = archiveMode.startsWith("no-newline-");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-preparation-"));
    const sourceRoot = path.join(root, "original");
    const privateStateDir = path.join(root, "preparation");
    const targetPath = path.join(root, "sessions.sqlite");
    try {
      let sourcePath = createLegacyDatabaseFixture({
        env: { OPENCLAW_STATE_DIR: sourceRoot },
        eventsBySession: {
          "session-a": [
            createEvent({
              id: "event-one",
              parentId: null,
              timestamp: 1000,
              message: {
                role: "user",
                content: "Keep this conversation and attachment.",
                MediaPath: "/fictional/bill.pdf",
                MediaType: "application/pdf",
                ...(archiveMode === "rejected-media"
                  ? { MediaPaths: ["", "/fictional/other.pdf"], MediaTypes: ["application/pdf"] }
                  : {}),
              },
            }),
          ],
        },
      });
      await closeOpenClawAgentDatabasesAsync(sourceRoot);
      closeOpenClawStateDatabase();
      if (
        archiveMode === "current-schema-media" ||
        archiveMode === "current-schema-lazy" ||
        archiveMode === "current-pre-additive"
      ) {
        const retiredEvent = readDatabaseSnapshot(sourcePath).rows[0]!.event_json;
        const currentPath = path.join(root, "current-source.sqlite");
        await prepareOfflineSessionSnapshot({
          sourcePath,
          targetPath: currentPath,
          agentId: "main",
          privateStateDir: path.join(root, "fixture-upgrade"),
        });
        const current = openNodeSqliteDatabase(currentPath);
        try {
          current.prepare("UPDATE transcript_events SET event_json=?").run(retiredEvent);
          if (archiveMode === "current-schema-lazy") {
            current.exec(
              "DROP TABLE session_participants; DROP TABLE session_transcript_archives; DROP TABLE message_tool_run_outcomes; DROP TABLE session_goal_operations; DROP TABLE session_progress_cards;",
            );
          }
        } finally {
          current.close();
        }
        sourcePath = currentPath;
      }
      const source = openNodeSqliteDatabase(sourcePath);
      try {
        if (
          archiveMode === "legacy-pre-additive" ||
          archiveMode === "current-pre-additive" ||
          archiveMode === "historical-source"
        ) {
          source.exec(`
              DROP TRIGGER session_nodes_entry_valid_after_insert;
              DROP TRIGGER session_nodes_entry_valid_after_entry_update;
              DROP TRIGGER session_nodes_entry_valid_after_identity_update;
              DROP INDEX idx_agent_session_nodes_entry_valid_pending;
              DROP INDEX idx_agent_transcript_event_parent;
              DROP TABLE session_key_contract;
              ALTER TABLE session_nodes DROP COLUMN entry_valid;
              ALTER TABLE session_nodes DROP COLUMN project_id;
              DROP TRIGGER session_conversations_route_context_invalidate_after_update;
              ALTER TABLE session_conversations DROP COLUMN route_context_json;
            `);
        }
        if (archiveMode === "historical-source") {
          source.exec(`
            ALTER TABLE session_nodes DROP COLUMN owner_actor_type;
            ALTER TABLE session_nodes DROP COLUMN owner_actor_id;
            ALTER TABLE session_nodes DROP COLUMN owner_assigned_by_type;
            ALTER TABLE session_nodes DROP COLUMN owner_assigned_by_id;
            ALTER TABLE session_nodes DROP COLUMN owner_assigned_at;
            DROP INDEX idx_agent_transcript_context_pending;
            ALTER TABLE session_transcript_active_events DROP COLUMN context_eligible;
            DROP TABLE context_engine_turn_outbox;
            DROP TABLE memory_entry_origins;
            DROP TABLE memory_session_tombstones;
            DROP TABLE message_tool_run_outcomes;
            DROP TABLE session_goal_operations;
            DROP TABLE session_pending_inputs;
            DROP TABLE session_progress_cards;
            DROP TABLE session_transcript_archives;
            CREATE TABLE state_leases (
              scope TEXT NOT NULL, lease_key TEXT NOT NULL, owner TEXT NOT NULL,
              expires_at INTEGER, heartbeat_at INTEGER, payload_json TEXT,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              PRIMARY KEY (scope, lease_key)
            ) STRICT;
            CREATE INDEX idx_agent_state_leases_expiry ON state_leases(expires_at, scope, lease_key) WHERE expires_at IS NOT NULL;
            CREATE INDEX idx_agent_state_leases_owner ON state_leases(owner, updated_at DESC);
            INSERT INTO state_leases VALUES ('fictional','old-lease','old-owner',NULL,1,'never-export-retired-runtime-payload',1,1);
          `);
          ensureMemoryChunkFtsSchema({
            db: source,
            ftsTable: "memory_index_chunks_fts",
            tokenizeClause: "",
          });
          ensureMemoryPathFtsSchema({ db: source, tokenizeClause: "" });
        }
        if (originalSchemaMutations[archiveMode]) {
          source.exec(originalSchemaMutations[archiveMode]);
        }
        if (archiveMode === "legacy-lazy") {
          source.exec(
            "DROP TABLE session_transcript_archives; DROP TABLE message_tool_run_outcomes; DROP TABLE session_goal_operations; DROP TABLE session_progress_cards;",
          );
        }
        if (archiveMode === "legacy-metadata") {
          source.exec(withLegacySessionParticipantsSchema(sessionParticipantsSchemaSql()));
          source.exec(`
              INSERT INTO session_participants VALUES
                ('agent:main:session-a','human','operator-a','profile',3,10,20),
                ('agent:main:session-a','agent','worker-a','agent',2,10,20),
                ('agent:main:session-a','human','channel-a','channel',NULL,10,20),
                ('agent:main:session-a','system','unknown-a',NULL,4,10,20),
                ('agent:main:session-a','agent','','agent',1,10,20),
                ('agent:main:session-a','human','','profile',1,10,20);
              UPDATE session_key_contract SET main_key='custom-primary', updated_at=42;
              UPDATE session_nodes SET entry_json='{"sessionId":"session-a","updatedAt":1000,"createdBy":{"id":"operator-a"}}';
            `);
        }
        source.exec(
          "INSERT INTO auth_profile_store VALUES ('fictional','never-export-this-credential',1)",
        );
      } finally {
        source.close();
      }
      const originalBytes = await fs.readFile(sourcePath);
      const original = readDatabaseSnapshot(sourcePath);
      const archiveName = `cold.jsonl.reset.2026-07-24T01-02-03.000Z${compressedArchive ? SESSION_ARCHIVE_ZSTD_SUFFIX : ""}`;
      const sourceArchive = path.join(sourceRoot, "agents", "main", "sessions", archiveName);
      const archivedEvent = createEvent({
        id: "archived-event",
        parentId: null,
        timestamp: 500,
        message: {
          role: "user",
          content: "Older conversation",
          ...(unchangedArchive ? {} : { MediaPath: "/fictional/old.pdf" }),
        },
      });
      if (withArchive) {
        writeArchive(sourceArchive, [archivedEvent], compressedArchive);
        if (archiveMode.startsWith("lossy-")) {
          const content =
            '{"counter":9007199254740993}\n' + readSessionArchiveContentSync(sourceArchive);
          await fs.writeFile(
            sourceArchive,
            compressedArchive ? encodeSessionArchiveContent(content).bytes : Buffer.from(content),
          );
        }
        if (archiveMode.startsWith("nul-") || noNewlineArchive) {
          const content = readSessionArchiveContentSync(sourceArchive);
          const altered = noNewlineArchive ? content.slice(0, -1) : content + "\0\0";
          await fs.writeFile(
            sourceArchive,
            compressedArchive ? encodeSessionArchiveContent(altered).bytes : Buffer.from(altered),
          );
        }
        if (archiveMode === "invalid-utf8-archive") {
          await fs.writeFile(
            sourceArchive,
            Buffer.concat([
              Buffer.from('{"type":"message","id":"bad","message":{"role":"user","content":"'),
              Buffer.from([0xff]),
              Buffer.from('"}}\n'),
            ]),
          );
        }
      }
      const archiveBytes = withArchive ? await fs.readFile(sourceArchive) : undefined;

      if (archiveMode === "aggregate-stored-zstd") {
        await fs.mkdir(path.dirname(sourceArchive), { recursive: true });
        // A valid zstd skippable frame consumes storage but emits no content.
        const padding = Buffer.alloc(776);
        padding.writeUInt32LE(0x184d2a50, 0);
        padding.writeUInt32LE(768, 4);
        const bytes = Buffer.concat([padding, encodeSessionArchiveContent("{}\n").bytes]);
        const paths = [
          sourceArchive,
          path.join(path.dirname(sourceArchive), archiveName.replace("cold.", "other.")),
        ];
        expect(paths[0]).not.toBe(paths[1]);
        for (const archive of paths) {
          await fs.writeFile(archive, bytes);
        }
        await expect(
          prepareOfflineSessionSnapshot({
            sourcePath,
            targetPath,
            agentId: "main",
            privateStateDir,
            maxTotalArchiveBytes: 1024,
          }),
        ).rejects.toThrow("Approved archive inventory exceeds its limit");
        expect((await fs.readFile(sourcePath)).equals(originalBytes)).toBe(true);
        for (const archive of paths) {
          expect((await fs.readFile(archive)).equals(bytes)).toBe(true);
        }
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        const copiedDirectory = path.join(privateStateDir, "agents", "main", "sessions");
        await expect(
          fs.stat(path.join(copiedDirectory, path.basename(paths[1]!))),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await prepareOfflineSessionSnapshot({
          sourcePath,
          targetPath,
          agentId: "main",
          privateStateDir: path.join(root, "exact-limit"),
          maxTotalArchiveBytes: bytes.byteLength * 2,
        });
        for (const archive of paths) {
          expect((await fs.readFile(path.join(root, path.basename(archive)))).equals(bytes)).toBe(
            true,
          );
        }
        return;
      }

      if (archiveMode === "symlink-archive" || archiveMode === "hardlink-archive") {
        const outsideArchive = path.join(root, "not-an-approved-source.jsonl");
        writeArchive(outsideArchive, [archivedEvent], false);
        await fs.mkdir(path.dirname(sourceArchive), { recursive: true });
        if (archiveMode === "symlink-archive") {
          await fs.symlink(outsideArchive, sourceArchive);
        } else {
          await fs.link(outsideArchive, sourceArchive);
        }
        await expect(
          prepareOfflineSessionSnapshot({
            sourcePath,
            targetPath,
            agentId: "main",
            privateStateDir,
          }),
        ).rejects.toThrow("Offline artifact");
        expect(await fs.readFile(sourcePath)).toEqual(originalBytes);
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(privateStateDir)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }

      if (archiveMode === "invalid-utf8-archive" || archiveMode.startsWith("lossy-")) {
        await expect(
          prepareOfflineSessionSnapshot({
            sourcePath,
            targetPath,
            agentId: "main",
            privateStateDir,
          }),
        ).rejects.toThrow();
        expect((await fs.readFile(sourcePath)).equals(originalBytes)).toBe(true);
        expect((await fs.readFile(sourceArchive)).equals(archiveBytes!)).toBe(true);
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          fs.stat(path.join(privateStateDir, "agents", "main", "agent", "openclaw-agent.sqlite")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      if (archiveMode === "rejected-media") {
        await expect(
          prepareOfflineSessionSnapshot({
            sourcePath,
            targetPath,
            agentId: "main",
            privateStateDir,
          }),
        ).rejects.toThrow("Offline preparation failed");
        expect(await fs.readFile(sourcePath)).toEqual(originalBytes);
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await fs.stat(privateStateDir)).isDirectory()).toBe(true);
        return;
      }
      if (originalSchemaMutations[archiveMode]) {
        await expect(
          prepareOfflineSessionSnapshot({
            sourcePath,
            targetPath,
            agentId: "main",
            privateStateDir,
          }),
        ).rejects.toThrow();
        expect((await fs.readFile(sourcePath)).equals(originalBytes)).toBe(true);
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        // Admission must fail before a migration input can be published.
        await expect(
          fs.stat(path.join(privateStateDir, "agents", "main", "agent", "openclaw-agent.sqlite")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      if (archiveMode === "isolated-cli" || archiveMode === "rejected-env") {
        const approved = await createFixturePreparationApproval({
          sourcePath,
          targetPath,
          agentId: "main",
          privateStateDir,
        });
        const run = (operation: "prepare" | "publish", publicationDigests: string[] = []) =>
          promisify(execFile)(
            process.execPath,
            [
              "--import",
              "./scripts/tsx.mjs",
              "scripts/offline-session-prepare.mts",
              operation,
              sourcePath,
              targetPath,
              "main",
              privateStateDir,
              approved.publicationDir,
              approved.approvalManifestPath,
              approved.approvalManifestSha256,
              ...publicationDigests,
            ],
            {
              cwd: process.cwd(),
              env: {
                PATH: process.env.PATH,
                LANG: "C.UTF-8",
                HOME: privateStateDir,
                OPENCLAW_HOME: privateStateDir,
                OPENCLAW_STATE_DIR: privateStateDir,
                OPENCLAW_CONFIG_PATH: path.join(privateStateDir, "openclaw.json"),
                TMPDIR: root,
                XDG_CACHE_HOME: root,
                ...(archiveMode === "rejected-env"
                  ? { OPENAI_API_KEY: "fictional-refuse-inherited-credential" }
                  : {}),
              },
              timeout: 60_000,
              maxBuffer: 64 * 1024,
              windowsHide: true,
            },
          );
        const execution = run("prepare");
        if (archiveMode === "rejected-env") {
          await expect(execution).rejects.toMatchObject({
            code: 1,
            stdout: "",
            stderr: expect.stringContaining("refused at input"),
          });
          expect(await fs.readFile(sourcePath)).toEqual(originalBytes);
          await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.stat(privateStateDir)).rejects.toMatchObject({ code: "ENOENT" });
          return;
        }
        const result = await execution;
        const staged = JSON.parse(result.stdout);
        expect(staged).toEqual({
          status: "prepared",
          schemaVersion: 19,
          preparationRecordSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          publicationIntentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        const publication = await run("publish", [
          staged.preparationRecordSha256,
          staged.publicationIntentSha256,
        ]);
        expect(JSON.parse(publication.stdout)).toEqual({
          status: "verified",
          schemaVersion: 19,
          cleanup: "removed",
        });
      } else {
        await prepareOfflineSessionSnapshot({
          sourcePath,
          targetPath,
          agentId: "main",
          privateStateDir,
        });
      }

      const result = readDatabaseSnapshot(targetPath);
      expect(result.version.user_version).toBe(19);
      expect(result.identities).toEqual(original.identities);
      expect(result.activeBranch).toEqual(original.activeBranch);
      expect(result.windows).toEqual(original.windows);
      expect(result.rows).toHaveLength(1);
      expect(JSON.parse(result.rows[0]!.event_json)).toEqual({
        type: "message",
        id: "event-one",
        parentId: null,
        timestamp: 1000,
        message: {
          role: "user",
          content: "Keep this conversation and attachment.",
          __openclaw: {
            media: [{ path: "/fictional/bill.pdf", contentType: "application/pdf" }],
          },
        },
      });
      expect(await fs.readFile(sourcePath)).toEqual(originalBytes);
      expect((await fs.readFile(targetPath)).includes("never-export-this-credential")).toBe(false);
      if (archiveMode === "historical-source") {
        expect(
          (await fs.readFile(targetPath)).includes("never-export-retired-runtime-payload"),
        ).toBe(false);
        const prepared = openNodeSqliteDatabase(targetPath, { readOnly: true });
        try {
          expect(
            prepared.prepare("SELECT name FROM sqlite_schema WHERE name='state_leases'").get(),
          ).toBeUndefined();
        } finally {
          prepared.close();
        }
      }
      if (withArchive) {
        expect(await fs.readFile(sourceArchive)).toEqual(archiveBytes);
        const publishedArchive = path.join(root, archiveName);
        const publishedContent = readSessionArchiveContentSync(publishedArchive);
        expect(publishedContent.endsWith("\n")).toBe(!noNewlineArchive);
        if (unchangedArchive) {
          expect((await fs.readFile(publishedArchive)).equals(archiveBytes!)).toBe(true);
        }
        expect(JSON.parse(publishedContent)).toEqual(
          unchangedArchive
            ? archivedEvent
            : {
                ...archivedEvent,
                message: {
                  role: "user",
                  content: "Older conversation",
                  __openclaw: {
                    media: [{ path: "/fictional/old.pdf" }],
                  },
                },
              },
        );
      }
      await expect(fs.stat(privateStateDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawStateDatabase();
      await fs.rm(root, { recursive: true });
    }
  });
});
import { execFile } from "node:child_process";
