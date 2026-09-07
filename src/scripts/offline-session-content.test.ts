import { expect, it } from "vitest";
import { captureOfflineSessionContent } from "../../scripts/lib/offline-session-content.mts";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { VERSION } from "../version.js";

it.each([
  { version: 16, futureWatermark: false },
  { version: 19, futureWatermark: false },
  { version: 16, futureWatermark: true },
  { version: 19, futureWatermark: true },
])(
  "accounts for native media conversion but refuses changed original history ($version, future=$futureWatermark)",
  ({ version, futureWatermark }) => {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      database.exec(`
      PRAGMA user_version = ${version};
      CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER);
      CREATE TABLE trajectory_runtime_events(session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER);
      CREATE TABLE session_transcript_archives(session_id TEXT, archive BLOB);
      CREATE TABLE transcript_event_identities(session_id TEXT, event_id TEXT, seq INTEGER);
      CREATE TABLE session_windows(session_id TEXT, session_key TEXT, transcript_updated_at INTEGER, transcript_observed_at INTEGER);
      CREATE TABLE transcript_rewrite_watermarks(session_id TEXT, generation TEXT, updated_at INTEGER);
      INSERT INTO session_windows VALUES ('session-a','agent:main:conversation-a',100,120), ('session-b','agent:main:conversation-b',10,20);
      INSERT INTO transcript_rewrite_watermarks VALUES ('session-a','00000000000000000000000000000000',1), ('session-b','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',1);
      INSERT INTO session_transcript_archives VALUES ('session-a', X'001122FF');
      INSERT INTO transcript_event_identities VALUES ('session-a', 'event-one', 1);
      CREATE TABLE session_key_contract(id INTEGER, main_key TEXT, updated_at INTEGER);
      INSERT INTO session_key_contract VALUES (1,'custom-primary',42);
      CREATE TABLE session_conversations(session_key TEXT, conversation_id TEXT, role TEXT);
      INSERT INTO session_conversations VALUES ('agent:main:conversation-a','conversation-a','primary');
      CREATE TABLE session_nodes(session_key TEXT, current_session_id TEXT, entry_json TEXT, entry_valid INTEGER, updated_at INTEGER, created_actor_type TEXT, created_actor_id TEXT);
      INSERT INTO session_nodes VALUES ('agent:main:conversation-a','session-a','{"sessionId":"session-a","updatedAt":10,"createdVia":"operator","createdActor":{"type":"human","id":"operator-a"}}',0,10,'human','operator-a');
      CREATE TABLE schema_meta(meta_key TEXT, role TEXT, schema_version INTEGER, agent_id TEXT, app_version TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE session_transcript_index_state(session_id TEXT, indexed_seq INTEGER, leaf_event_id TEXT, active_event_count INTEGER, active_message_count INTEGER, needs_rebuild INTEGER, updated_at INTEGER);
      CREATE TABLE session_transcript_active_events(session_id TEXT, active_position INTEGER, event_seq INTEGER, message_position INTEGER, context_eligible INTEGER);
      CREATE VIRTUAL TABLE session_transcript_fts USING fts5(text,session_id UNINDEXED,message_id UNINDEXED,role UNINDEXED,timestamp UNINDEXED);
      INSERT INTO session_transcript_index_state VALUES ('session-a',1,'event-one',1,1,0,10);
      INSERT INTO session_transcript_active_events VALUES ('session-a',0,1,0,1);
      INSERT INTO session_transcript_fts VALUES ('Keep the original text.','session-a','event-one','user',1000);
    `);
      database
        .prepare("INSERT INTO schema_meta VALUES ('primary','agent',?,'main',?,1,2)")
        .run(version, version === 19 ? VERSION : "legacy-test");
      if (version === 16) {
        database.exec(`
          CREATE TABLE session_participants(session_key TEXT, actor_type TEXT, actor_id TEXT, actor_source TEXT, contribution_count INTEGER, first_prompted_at INTEGER, last_prompted_at INTEGER);
          INSERT INTO session_participants VALUES ('agent:main:conversation-a','human','operator-a','profile',3,10,20);
        `);
      } else {
        database.exec(`
          CREATE TABLE session_participants(session_key TEXT, identity_namespace TEXT, actor_id TEXT, contribution_count INTEGER, first_prompted_at INTEGER, last_prompted_at INTEGER);
          INSERT INTO session_participants VALUES ('agent:main:conversation-a','{"type":"profile"}','operator-a',3,NULL,NULL);
          ALTER TABLE session_conversations ADD COLUMN route_context_json TEXT;
        `);
      }
      for (const table of [
        "conversations",
        "session_members",
        "session_suggestions",
        "board_tabs",
        "board_widgets",
        "session_progress_cards",
        "heartbeat_outcomes",
        "message_tool_run_outcomes",
        "session_goal_operations",
        "acp_parent_stream_events",
      ]) {
        database.exec(`CREATE TABLE ${table}(id INTEGER, payload TEXT)`);
      }
      database.exec(
        "INSERT INTO session_goal_operations VALUES (1,'Preserve the completed receipt.')",
      );
      const original = JSON.stringify({
        type: "message",
        id: "event-one",
        parentId: null,
        message: {
          role: "user",
          content: "Keep the original text.",
          MediaPath: "/fictional/bill.pdf",
        },
      });
      database
        .prepare("INSERT INTO transcript_events VALUES ('session-a',1,?,9007199254740993)")
        .run(original);
      const originalObservation = futureWatermark ? Date.now() + 60_000 : 120;
      database
        .prepare("UPDATE session_windows SET transcript_observed_at=? WHERE session_id='session-a'")
        .run(originalObservation);
      for (const suffix of ['"opaque":9007199254740993', '"opaque":1,"opaque":2']) {
        database
          .prepare("UPDATE transcript_events SET event_json=?")
          .run(original.slice(0, -1) + "," + suffix + "}");
        expect(() => captureOfflineSessionContent(database)).toThrow("lossy JSON");
        database
          .prepare("UPDATE transcript_events SET event_json=?")
          .run('{"type":"message","message":{"role":"user","content":"Unchanged"},' + suffix + "}");
        expect(() => captureOfflineSessionContent(database)).not.toThrow();
        database.prepare("UPDATE transcript_events SET event_json=?").run(original);
        database
          .prepare("INSERT INTO trajectory_runtime_events VALUES ('session-a',1,?,1)")
          .run(
            '{"data":{"messagesSnapshot":[{"role":"user","MediaPath":"x"},{"role":"assistant",' +
              suffix +
              "}]}}",
          );
        expect(() => captureOfflineSessionContent(database)).toThrow("lossy JSON");
        database
          .prepare("UPDATE trajectory_runtime_events SET event_json=?")
          .run('{"data":{"messagesSnapshot":[{"role":"assistant",' + suffix + "}]}}");
        expect(() => captureOfflineSessionContent(database)).not.toThrow();
        database.exec("DELETE FROM trajectory_runtime_events");
        const entry = database.prepare("SELECT entry_json FROM session_nodes").get()!
          .entry_json as string;
        database
          .prepare("UPDATE session_nodes SET entry_json=?")
          .run(entry.slice(0, -1) + "," + suffix + "}");
        if (version === 16) {
          expect(() => captureOfflineSessionContent(database)).toThrow("lossy JSON");
          database
            .prepare("UPDATE session_nodes SET entry_json=?")
            .run(entry.replace('"human"', '"agent"').slice(0, -1) + "," + suffix + "}");
          expect(() => captureOfflineSessionContent(database)).not.toThrow();
        } else {
          // Native19 does not reserialize creator metadata; preserve original bytes.
          expect(() => captureOfflineSessionContent(database)).not.toThrow();
        }
        database.prepare("UPDATE session_nodes SET entry_json=?").run(entry);
      }
      const accounting = captureOfflineSessionContent(database);
      const prepared = JSON.stringify({
        type: "message",
        id: "event-one",
        parentId: null,
        message: {
          role: "user",
          content: "Keep the original text.",
          __openclaw: { media: [{ path: "/fictional/bill.pdf" }] },
        },
      });
      database.prepare("UPDATE transcript_events SET event_json=?").run(prepared);
      database.exec("PRAGMA user_version=19");
      database.exec("ALTER TABLE session_nodes ADD COLUMN project_id TEXT");
      if (version === 16) {
        database
          .prepare("UPDATE session_nodes SET entry_json=?")
          .run(
            '{"sessionId":"session-a","updatedAt":10,"createdVia":"operator","createdActor":{"type":"human","id":"operator-a","source":"profile"}}',
          );
        database
          .prepare("UPDATE schema_meta SET schema_version=19,app_version=?,updated_at=?")
          .run(VERSION, Date.now());
      } else {
        database.exec("UPDATE session_nodes SET entry_valid=1");
      }
      if (version === 16) {
        database.exec(`
          DROP TABLE session_participants;
          CREATE TABLE session_participants(session_key TEXT, identity_namespace TEXT, actor_id TEXT, contribution_count INTEGER, first_prompted_at INTEGER, last_prompted_at INTEGER);
          INSERT INTO session_participants VALUES ('agent:main:conversation-a','{"type":"profile"}','operator-a',3,NULL,NULL);
          ALTER TABLE session_conversations ADD COLUMN route_context_json TEXT;
        `);
      }
      const mutationTime = Math.max(Date.now(), originalObservation + 1);
      database
        .prepare("UPDATE session_windows SET transcript_updated_at=? WHERE session_id='session-a'")
        .run(mutationTime);
      database
        .prepare(
          "UPDATE transcript_rewrite_watermarks SET generation=?, updated_at=? WHERE session_id='session-a'",
        )
        .run("11111111111111111111111111111111", Date.now());
      expect(() => accounting.assertPrepared(database)).not.toThrow();
      database.exec("UPDATE session_transcript_fts SET text='Foreign indexed text.'");
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
      database.exec("UPDATE session_transcript_fts SET text='Keep the original text.'");
      database.exec("UPDATE session_transcript_active_events SET context_eligible=0");
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
      database.exec("UPDATE session_transcript_active_events SET context_eligible=1");
      database.exec("UPDATE session_transcript_index_state SET leaf_event_id='foreign-leaf'");
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
      database.exec("UPDATE session_transcript_index_state SET leaf_event_id='event-one'");
      database.exec("UPDATE session_nodes SET created_actor_id='foreign-operator'");
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
      database.exec("UPDATE session_nodes SET created_actor_id='operator-a'");
      database.exec("UPDATE schema_meta SET agent_id='foreign-agent'");
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
      database.exec("UPDATE schema_meta SET agent_id='main'");
      database.exec("UPDATE session_participants SET actor_id='foreign-operator'");
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
      database.exec("UPDATE session_participants SET actor_id='operator-a'");
      database.exec("UPDATE session_key_contract SET main_key='main'");
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
      database.exec("UPDATE session_key_contract SET main_key='custom-primary'");
      database.exec("UPDATE session_conversations SET conversation_id='foreign-conversation'");
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
      database.exec("UPDATE session_conversations SET conversation_id='conversation-a'");
      database.exec("DELETE FROM session_key_contract");
      const emptyContract = captureOfflineSessionContent(database);
      database.exec("INSERT INTO session_key_contract VALUES (1,'main',0)");
      database.exec("UPDATE session_nodes SET entry_valid=1");
      expect(() => emptyContract.assertPrepared(database)).not.toThrow();
      database.prepare("UPDATE session_nodes SET entry_valid=?").run(version === 16 ? 0 : 1);
      database.exec("UPDATE session_key_contract SET main_key='custom-primary', updated_at=42");
      database
        .prepare("UPDATE session_windows SET transcript_updated_at=? WHERE session_id='session-a'")
        .run(mutationTime + 1_000_000);
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
      database
        .prepare("UPDATE session_windows SET transcript_updated_at=? WHERE session_id='session-a'")
        .run(mutationTime);
      database.exec(
        "UPDATE session_windows SET transcript_updated_at=121 WHERE session_id='session-a'",
      );
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
      database
        .prepare("UPDATE session_windows SET transcript_updated_at=? WHERE session_id='session-a'")
        .run(mutationTime);
      database.exec(
        "UPDATE session_windows SET session_key='agent:main:foreign' WHERE session_id='session-a'",
      );
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
      database.exec(
        "UPDATE session_windows SET session_key='agent:main:conversation-a' WHERE session_id='session-a'",
      );
      database
        .prepare("UPDATE transcript_events SET event_json=?")
        .run(prepared.replace("Keep the original text.", "Replaced text."));
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
      database.prepare("UPDATE transcript_events SET event_json=?").run(prepared);
      database.exec("UPDATE transcript_events SET created_at=9007199254740992");
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
      database.exec(
        "UPDATE transcript_events SET created_at=9007199254740993; DELETE FROM transcript_event_identities",
      );
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
      database.exec(
        "INSERT INTO transcript_event_identities VALUES ('session-a','event-one',1); DELETE FROM session_goal_operations",
      );
      expect(() => accounting.assertPrepared(database)).toThrow(
        "Offline original history accounting",
      );
    } finally {
      database.close();
    }
  },
);
