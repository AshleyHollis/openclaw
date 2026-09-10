import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureMemoryChunkFtsSchema,
  ensureMemoryPathFtsSchema,
} from "../../packages/memory-host-sdk/src/host/memory-schema-fts.js";
import { createOfflineSessionSnapshot } from "../../scripts/lib/offline-session-snapshot.mts";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createPrivateSqliteDirectory } from "../infra/sqlite-private-directory.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";

describe("offline Session snapshot", () => {
  it.each([
    ["unclassified table", "CREATE TABLE private_extension (secret TEXT)", "unclassified"],
    [
      "unclassified column",
      "ALTER TABLE session_nodes ADD COLUMN private_extension TEXT",
      "unclassified",
    ],
    [
      "unclassified trigger",
      "CREATE TRIGGER private_extension AFTER DELETE ON auth_profile_store BEGIN DELETE FROM transcript_events; END",
      "unexpected trigger",
    ],
    ["wrong agent", "UPDATE schema_meta SET agent_id = 'another-agent'", "agent"],
    [
      "unprepared schema",
      "PRAGMA user_version = 16; UPDATE schema_meta SET schema_version = 16",
      "schema version",
    ],
    ["inconsistent metadata", "UPDATE schema_meta SET schema_version = 18", "metadata"],
    [
      "orphaned Memory shadow table",
      "CREATE TABLE memory_index_chunks_fts_data(id INTEGER PRIMARY KEY, block BLOB)",
      "schema",
    ],
    [
      "noncanonical Memory index",
      "CREATE VIRTUAL TABLE memory_index_chunks_fts USING fts5(private_extension)",
      "schema",
    ],
  ])("refuses %s without publishing or changing the source", async (_name, mutation, error) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-sessions-"));
    const sourcePath = path.join(root, "source.sqlite");
    const targetPath = path.join(root, "sessions.sqlite");
    const source = openNodeSqliteDatabase(sourcePath);
    try {
      source.exec(OPENCLAW_AGENT_SCHEMA_SQL);
      source.exec("PRAGMA user_version = 19");
      source.exec("INSERT INTO schema_meta VALUES ('primary','agent',19,'main','2026.9.2',1,1)");
      source.exec(mutation);
      source.close();
      const before = await fs.readFile(sourcePath);

      await expect(
        createOfflineSessionSnapshot({ sourcePath, targetPath, agentId: "main" }),
      ).rejects.toThrow(error);

      expect(await fs.readFile(sourcePath)).toEqual(before);
      expect(await fs.readdir(root)).toEqual(["source.sqlite"]);
    } finally {
      if (source.isOpen) {
        source.close();
      }
      await fs.rm(root, { recursive: true });
    }
  });

  it("preserves history and orphaned archive bytes while removing active and deleted credentials", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-sessions-"));
    const privateRoot = path.join(root, "private");
    await createPrivateSqliteDirectory(privateRoot);
    const sourcePath = path.join(privateRoot, "source.sqlite");
    const targetPath = path.join(privateRoot, "sessions.sqlite");
    const activeSecret = `active-credential-${"A".repeat(512)}`;
    const deletedSecret = `deleted-credential-${"B".repeat(512)}`;
    const activeIntent = "fictionalactiveintentprivatekeyword";
    const deletedIntent = "fictionaldeletedintentprivatekeyword";
    const deletedTranscriptToken = "fictionaldeletedtranscriptprivatekeyword";
    const excludedMemoryToken = "fictionalexcludedmemoryprivatekeyword";
    const archive = Buffer.from("fictional archived conversation\u0000with binary content");
    const source = openNodeSqliteDatabase(sourcePath);
    try {
      source.exec(OPENCLAW_AGENT_SCHEMA_SQL);
      source.exec("PRAGMA user_version = 19; PRAGMA secure_delete = OFF;");
      ensureMemoryChunkFtsSchema({
        db: source,
        ftsTable: "memory_index_chunks_fts",
        tokenizeClause: "",
      });
      ensureMemoryPathFtsSchema({ db: source, tokenizeClause: "" });
      source
        .prepare(
          "INSERT INTO memory_index_sources (path,source,hash,mtime,size) VALUES (?,'memory','fictional',1,1)",
        )
        .run(excludedMemoryToken);
      source
        .prepare(
          "INSERT INTO memory_index_chunks_fts (text,id,path,source,model,start_line,end_line) VALUES (?,'chunk-1','fictional.md','memory','fictional',1,1)",
        )
        .run(excludedMemoryToken);
      source.exec("INSERT INTO schema_meta VALUES ('primary','agent',19,'main','2026.9.2',1,1)");
      source.exec(
        "INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at) VALUES ('agent:main:fictional','window-1','{}',1)",
      );
      source.exec(
        "INSERT INTO session_windows (session_id,session_key,created_at,updated_at) VALUES ('window-1','agent:main:fictional',1,1)",
      );
      source.exec(
        "INSERT INTO transcript_events VALUES ('window-1',1,'{\"text\":\"retained history\"}',1)",
      );
      source.exec(
        "INSERT INTO transcript_rewrite_watermarks VALUES ('window-1','unchanged-generation',1)",
      );
      source
        .prepare(
          "INSERT INTO session_transcript_archives (session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,archive_name,created_at) VALUES ('old-window','old-generation','agent:main:fictional','reset','identity',?,?, 'old.reset',1)",
        )
        .run(archive, "c".repeat(64));
      source.prepare("INSERT INTO auth_profile_store VALUES ('active',?,1)").run(activeSecret);
      source.prepare("INSERT INTO auth_profile_state VALUES ('deleted',?,1)").run(deletedSecret);
      source.exec("DELETE FROM auth_profile_state");
      const addIntent = source.prepare(
        "INSERT INTO standing_intents (id,description,trigger_keywords,status,expires_at,max_fires,created_at) VALUES (?,'fictional intent',?,'pending',99,1,1)",
      );
      addIntent.run("active-intent", activeIntent);
      addIntent.run("deleted-intent", deletedIntent);
      source.exec("DELETE FROM standing_intents WHERE id = 'deleted-intent'");
      source
        .prepare(
          "INSERT INTO session_transcript_fts(rowid,text,session_id,message_id,role,timestamp) VALUES (41,?,'window-1','message-1','user',1)",
        )
        .run(deletedTranscriptToken);
      source.exec("UPDATE session_transcript_fts SET text = 'retained history' WHERE rowid = 41");
      // Native media migration runs ANALYZE; its output must remain admissible.
      source.exec("ANALYZE main");
      source.close();
      const before = await fs.readFile(sourcePath);
      expect(before.includes(deletedSecret)).toBe(true);
      expect(before.includes(deletedIntent)).toBe(true);
      expect(before.includes(deletedTranscriptToken)).toBe(true);
      expect(before.includes(excludedMemoryToken)).toBe(true);

      await createOfflineSessionSnapshot({ sourcePath, targetPath, agentId: "main" });

      const output = openNodeSqliteDatabase(targetPath, { readOnly: true });
      try {
        expect(output.prepare("SELECT count(*) AS n FROM auth_profile_store").get()).toEqual({
          n: 0,
        });
        expect(output.prepare("SELECT count(*) AS n FROM standing_intents").get()).toEqual({
          n: 0,
        });
        expect(output.prepare("SELECT count(*) AS n FROM sqlite_stat1").get()).toEqual({ n: 0 });
        expect(output.prepare("SELECT count(*) AS n FROM memory_index_chunks_fts").get()).toEqual({
          n: 0,
        });
        expect(output.prepare("SELECT count(*) AS n FROM memory_index_paths_fts").get()).toEqual({
          n: 0,
        });
        expect(output.prepare("SELECT rowid,text FROM session_transcript_fts").get()).toEqual({
          rowid: 41,
          text: "retained history",
        });
        expect(output.prepare("SELECT event_json FROM transcript_events").get()).toEqual({
          event_json: '{"text":"retained history"}',
        });
        expect(
          output.prepare("SELECT generation FROM transcript_rewrite_watermarks").get(),
        ).toEqual({ generation: "unchanged-generation" });
        expect(
          Buffer.from(
            output.prepare("SELECT archive_blob FROM session_transcript_archives").get()!
              .archive_blob as Uint8Array,
          ),
        ).toEqual(archive);
      } finally {
        output.close();
      }
      const published = await fs.readFile(targetPath);
      expect(published.includes(activeSecret)).toBe(false);
      expect(published.includes(deletedSecret)).toBe(false);
      expect(published.includes(activeIntent)).toBe(false);
      expect(published.includes(deletedIntent)).toBe(false);
      expect(published.includes(deletedTranscriptToken)).toBe(false);
      expect(published.includes(excludedMemoryToken)).toBe(false);
      expect(await fs.readFile(sourcePath)).toEqual(before);
      expect((await fs.readdir(privateRoot)).toSorted()).toEqual([
        "sessions.sqlite",
        "source.sqlite",
      ]);

      await expect(
        createOfflineSessionSnapshot({ sourcePath, targetPath, agentId: "main" }),
      ).rejects.toThrow();
      expect(await fs.readFile(targetPath)).toEqual(published);
      expect(await fs.readFile(sourcePath)).toEqual(before);
    } finally {
      if (source.isOpen) {
        source.close();
      }
      await fs.rm(root, { recursive: true });
    }
  });
});
