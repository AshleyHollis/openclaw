import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseSqliteSessionEntryRecord } from "../../src/config/sessions/session-entry-json.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import { quoteSqliteIdentifier } from "../../src/infra/sqlite-schema-sql.js";
import { readSqliteUserVersion } from "../../src/infra/sqlite-user-version.js";
import {
  canonicalizePersistedUserMessageMedia,
  hasMeaningfulRetiredMediaCarrier,
} from "../../src/media/media-facts.js";
import { migrateLegacySessionCreator } from "../../src/state/creator-namespace-migration.js";
import { hasPendingMemoryChunkMetadataMigration } from "../../src/state/openclaw-agent-db-schema-helpers.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../src/state/openclaw-agent-schema.js";
import { tableExists } from "../../src/state/openclaw-state-db-schema-helpers.js";
import { VERSION } from "../../src/version.js";
import { assertLosslessReserialization } from "./offline-session-json.mts";
import { captureOfflineSessionProjections } from "./offline-session-projections.mts";
import { encodedRow, rowsDigest, tableRows } from "./offline-session-rows.mts";

// These durable tables have no permitted row transformation in native 16→19,
// apart from the two explicitly handled media JSON columns below. Derived
// projections, creator/participant migrations and revision watermarks require
// separate source-specific accounting; this is not a whole-database receipt.
const HISTORY_TABLES = [
  "transcript_events",
  "trajectory_runtime_events",
  "session_transcript_archives",
  "transcript_event_identities",
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
] as const;

const LAZY_HISTORY_TABLES = new Set<string>([
  "session_transcript_archives",
  "message_tool_run_outcomes",
  "session_goal_operations",
  "session_progress_cards",
]);

function createdHistoryTableFields(database: DatabaseSync, version: number) {
  const expected = new Map<string, string[]>();
  if (version !== 16 && !hasPendingMemoryChunkMetadataMigration(database)) {
    return expected;
  }
  const missing = [...LAZY_HISTORY_TABLES].filter((table) => !tableExists(database, table));
  if (missing.length === 0) {
    return expected;
  }
  const canonical = openNodeSqliteDatabase(":memory:");
  try {
    canonical.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    for (const table of missing) {
      expected.set(
        table,
        canonical
          .prepare(`SELECT * FROM ${quoteSqliteIdentifier(table)} LIMIT 0`)
          .columns()
          .map((field) => field.name),
      );
    }
  } finally {
    canonical.close();
  }
  return expected;
}

function expectedMediaJson(raw: string, trajectory: boolean): string {
  let event: unknown;
  try {
    event = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Offline original history accounting requires valid event JSON.");
  }
  if (!isRecord(event)) {
    return raw;
  }
  if (!trajectory) {
    if (event.type !== "message" || !isRecord(event.message)) {
      return raw;
    }
    const result = canonicalizePersistedUserMessageMedia(event.message);
    if (result.changed) {
      assertLosslessReserialization(raw);
    }
    return result.changed ? JSON.stringify({ ...event, message: result.message }) : raw;
  }
  if (!isRecord(event.data) || !Array.isArray(event.data.messagesSnapshot)) {
    return raw;
  }
  let changed = false;
  const messagesSnapshot = event.data.messagesSnapshot.map((message: unknown) => {
    if (!isRecord(message) || !hasMeaningfulRetiredMediaCarrier(message)) {
      return message;
    }
    const result = canonicalizePersistedUserMessageMedia(message);
    changed ||= result.changed;
    return result.message;
  });
  if (changed) {
    assertLosslessReserialization(raw);
  }
  return changed ? JSON.stringify({ ...event, data: { ...event.data, messagesSnapshot } }) : raw;
}

function expectedSessionNodes(database: DatabaseSync, version: number) {
  // Use the native migration's SQL admission predicate: an absent actor is not JSON null.
  const creatorKeys = new Set(
    version === 16
      ? database
          .prepare(`SELECT session_key FROM session_nodes
    WHERE json_valid(entry_json) AND (json_extract(entry_json, '$.createdActor.type') = 'human'
      OR (json_type(entry_json, '$.createdActor') IS NULL AND json_type(entry_json, '$.createdBy') = 'object'))`)
          .all()
          .map((row) => row.session_key)
      : [],
  );
  return tableRows(database, "session_nodes").map((row) => {
    row.project_id ??= null;
    if (row.entry_valid === undefined || row.entry_valid === 0n) {
      if (
        typeof row.updated_at !== "bigint" ||
        !Number.isSafeInteger(Number(row.updated_at)) ||
        typeof row.entry_json !== "string" ||
        typeof row.current_session_id !== "string"
      ) {
        throw new Error(
          "Offline original history accounting refuses unsupported Session identity.",
        );
      }
      row.entry_valid = parseSqliteSessionEntryRecord({
        current_session_id: row.current_session_id,
        entry_json: row.entry_json,
        updated_at: Number(row.updated_at),
      })
        ? 1n
        : -1n;
    }
    if (creatorKeys.has(row.session_key)) {
      if (typeof row.entry_json !== "string") {
        throw new Error("Offline original history accounting requires Session entry text.");
      }
      // SAFETY: The native SQL predicate above admits valid JSON creator records;
      // the pure native converter preserves other fields without reconstructing the entry.
      assertLosslessReserialization(row.entry_json);
      const entry = migrateLegacySessionCreator(JSON.parse(row.entry_json) as SessionEntry);
      row.entry_json = JSON.stringify(entry);
      row.created_actor_type = entry.createdActor?.type ?? null;
      // Native UPDATE applies TEXT affinity to the retired actor's identifier.
      row.created_actor_id = database
        .prepare("SELECT CAST(? AS TEXT) AS value")
        .get(entry.createdActor?.id ?? null)!.value!;
      row.entry_valid = 0n;
    }
    return row;
  });
}

function captureSchemaMetadata(database: DatabaseSync, version: number) {
  const rows = tableRows(database, "schema_meta");
  const primary = rows.find((row) => row.meta_key === "primary");
  if (
    !primary ||
    rows.filter((row) => row.meta_key === "primary").length !== 1 ||
    primary.role !== "agent" ||
    primary.schema_version !== BigInt(version) ||
    typeof primary.agent_id !== "string" ||
    normalizeAgentId(primary.agent_id) !== primary.agent_id ||
    primary.agent_id.length === 0
  ) {
    throw new Error("Offline original history accounting refuses inconsistent schema ownership.");
  }
  const changes = version !== 19 || primary.app_version !== VERSION;
  const expected = rowsDigest(rows);
  const startedAt = BigInt(Date.now());
  return (prepared: DatabaseSync): void => {
    const current = tableRows(prepared, "schema_meta");
    const next = current.find((row) => row.meta_key === "primary");
    const finishedAt = BigInt(Date.now());
    const earliest = startedAt < finishedAt ? startedAt : finishedAt;
    const latest = startedAt > finishedAt ? startedAt : finishedAt;
    if (changes) {
      if (
        !next ||
        next.schema_version !== 19n ||
        next.app_version !== VERSION ||
        typeof next.updated_at !== "bigint" ||
        next.updated_at < earliest ||
        next.updated_at > latest
      ) {
        throw new Error("Offline original history accounting rejected schema metadata changes.");
      }
      next.schema_version = primary.schema_version!;
      next.app_version = primary.app_version!;
      next.updated_at = primary.updated_at!;
    }
    if (rowsDigest(current) !== expected) {
      throw new Error("Offline original history accounting rejected changed schema ownership.");
    }
  };
}

function captureSessionMetadata(database: DatabaseSync, version: number) {
  const hadParticipants = tableExists(database, "session_participants");
  const requiresParticipants =
    hadParticipants || version === 16 || hasPendingMemoryChunkMetadataMigration(database);
  const originalParticipants = hadParticipants ? tableRows(database, "session_participants") : [];
  const participants = originalParticipants.map((row) => {
    if (version === 19) {
      return row;
    }
    const allowed = new Set([
      "session_key",
      "actor_type",
      "actor_id",
      "actor_source",
      "contribution_count",
      "first_prompted_at",
      "last_prompted_at",
    ]);
    if (Object.keys(row).some((field) => !allowed.has(field))) {
      throw new Error("Offline original history accounting refuses unknown participant fields.");
    }
    const source = row.actor_source ?? null;
    const knownAgent = row.actor_type === "agent" && source === "agent" && row.actor_id !== "";
    const knownObservation = knownAgent || (row.actor_type === "human" && source === "channel");
    const namespace =
      row.actor_type === "human" && source === "profile" && row.actor_id !== ""
        ? { type: "profile" }
        : knownAgent
          ? { type: "agent" }
          : { type: "legacy", actorType: row.actor_type, source };
    return {
      session_key: row.session_key!,
      identity_namespace: JSON.stringify(namespace),
      actor_id: row.actor_id!,
      contribution_count: row.contribution_count ?? 1n,
      first_prompted_at: knownObservation ? row.first_prompted_at! : null,
      last_prompted_at: knownObservation ? row.last_prompted_at! : null,
    };
  });
  const contract = tableExists(database, "session_key_contract")
    ? tableRows(database, "session_key_contract")
    : [];
  if (!contract.some((row) => row.id === 1n)) {
    contract.push({ id: 1n, main_key: "main", updated_at: 0n });
  }
  const conversations = tableRows(database, "session_conversations").map((row) => {
    row.route_context_json ??= null;
    return row;
  });
  const expectations = [
    ["session_nodes", rowsDigest(expectedSessionNodes(database, version))],
    ["session_participants", rowsDigest(participants)],
    ["session_key_contract", rowsDigest(contract)],
    ["session_conversations", rowsDigest(conversations)],
  ] as const;
  return (prepared: DatabaseSync): void => {
    for (const [table, expected] of expectations) {
      if (table === "session_participants" && !requiresParticipants) {
        if (tableExists(prepared, table)) {
          throw new Error(
            "Offline original history accounting rejected an unexpected participant table.",
          );
        }
        continue;
      }
      if (rowsDigest(tableRows(prepared, table)) !== expected) {
        throw new Error("Offline original history accounting rejected changed Session metadata.");
      }
    }
  };
}

function contentDigest(
  database: DatabaseSync,
  convertLegacyMedia: boolean,
  rewrittenSessions?: Map<string, bigint>,
  createdFields?: ReadonlyMap<string, string[]>,
): string {
  const digest = createHash("sha256");
  for (const table of HISTORY_TABLES) {
    if (LAZY_HISTORY_TABLES.has(table) && !tableExists(database, table)) {
      // Absence differs from empty: only native full-DDL creates these tables.
      digest.update(JSON.stringify([table, createdFields?.get(table) ?? null]));
      continue;
    }
    const quoted = quoteSqliteIdentifier(table);
    const fields = database
      .prepare(`SELECT * FROM ${quoted} LIMIT 0`)
      .columns()
      .map((field) => field.name);
    digest.update(JSON.stringify([table, fields]));
    const query = database.prepare(
      `SELECT * FROM ${quoted} ORDER BY ${fields.map(quoteSqliteIdentifier).join(",")}`,
    );
    query.setReadBigInts(true);
    for (const row of query.iterate()) {
      if (
        convertLegacyMedia &&
        (table === "transcript_events" || table === "trajectory_runtime_events")
      ) {
        if (typeof row.event_json !== "string") {
          throw new Error("Offline original history accounting requires event text.");
        }
        const original = row.event_json;
        row.event_json = expectedMediaJson(original, table === "trajectory_runtime_events");
        if (table === "transcript_events" && row.event_json !== original) {
          if (typeof row.session_id !== "string") {
            throw new Error("Offline original history accounting requires Session identity.");
          }
          if (rewrittenSessions) {
            rewrittenSessions.set(
              row.session_id,
              (rewrittenSessions.get(row.session_id) ?? 0n) + 1n,
            );
          }
        }
      }
      digest.update(encodedRow(row));
      digest.update("\n");
    }
  }
  return digest.digest("hex");
}

function sessionRows(
  database: DatabaseSync,
  table: "session_windows" | "transcript_rewrite_watermarks",
) {
  const query = database.prepare(
    `SELECT * FROM ${quoteSqliteIdentifier(table)} ORDER BY session_id`,
  );
  query.setReadBigInts(true);
  const rows = new Map<string, Record<string, SQLOutputValue>>();
  for (const row of query.iterate()) {
    if (typeof row.session_id !== "string" || rows.has(row.session_id)) {
      throw new Error("Offline original history accounting requires unique Session identities.");
    }
    rows.set(row.session_id, row);
  }
  return rows;
}

function captureSessionBindings(
  database: DatabaseSync,
  rewrittenSessions: ReadonlyMap<string, bigint>,
) {
  const windows = sessionRows(database, "session_windows");
  const watermarks = sessionRows(database, "transcript_rewrite_watermarks");
  const startedAt = BigInt(Date.now());
  function refuse(): never {
    throw new Error(
      "Offline original history accounting rejected changed Session bindings or revisions.",
    );
  }
  for (const sessionId of rewrittenSessions.keys()) {
    if (!windows.has(sessionId)) {
      refuse();
    }
  }
  return (prepared: DatabaseSync): void => {
    const finishedAt = BigInt(Date.now());
    const earliest = startedAt < finishedAt ? startedAt : finishedAt;
    const latest = startedAt > finishedAt ? startedAt : finishedAt;
    const currentWindows = sessionRows(prepared, "session_windows");
    if (currentWindows.size !== windows.size) {
      refuse();
    }
    for (const [sessionId, original] of windows) {
      const current = currentWindows.get(sessionId);
      if (!current) {
        refuse();
      }
      if (rewrittenSessions.has(sessionId)) {
        const priorUpdated = original.transcript_updated_at ?? -1n;
        const priorObserved = original.transcript_observed_at ?? -1n;
        const next = current.transcript_updated_at;
        if (
          typeof priorUpdated !== "bigint" ||
          typeof priorObserved !== "bigint" ||
          typeof next !== "bigint" ||
          next < earliest ||
          next <= priorUpdated ||
          next <= priorObserved
        ) {
          refuse();
        }
        // Each native rewrite batch contains at least one rewritten event.
        // This admits future original watermarks and multiple batches without
        // permitting an unrelated arbitrarily large revision jump.
        const ceiling =
          [latest, priorUpdated, priorObserved].reduce((maximum, value) =>
            value > maximum ? value : maximum,
          ) + (rewrittenSessions.get(sessionId) ?? 0n);
        if (next > ceiling) {
          refuse();
        }
        current.transcript_updated_at = original.transcript_updated_at!;
      }
      if (encodedRow(current) !== encodedRow(original)) {
        refuse();
      }
    }
    const currentWatermarks = sessionRows(prepared, "transcript_rewrite_watermarks");
    const inserted = [...rewrittenSessions.keys()].filter((id) => !watermarks.has(id)).length;
    if (currentWatermarks.size !== watermarks.size + inserted) {
      refuse();
    }
    for (const [sessionId, current] of currentWatermarks) {
      const original = watermarks.get(sessionId);
      if (!rewrittenSessions.has(sessionId)) {
        if (!original || encodedRow(current) !== encodedRow(original)) {
          refuse();
        }
        continue;
      }
      if (
        typeof current.generation !== "string" ||
        !/^[a-f0-9]{32}$/.test(current.generation) ||
        current.generation === original?.generation ||
        typeof current.updated_at !== "bigint" ||
        current.updated_at < earliest ||
        current.updated_at > latest
      ) {
        refuse();
      }
      if (original) {
        current.generation = original.generation!;
        current.updated_at = original.updated_at!;
        if (encodedRow(current) !== encodedRow(original)) {
          refuse();
        }
      } else if (Object.keys(current).toSorted().join(",") !== "generation,session_id,updated_at") {
        refuse();
      }
    }
    for (const sessionId of rewrittenSessions.keys()) {
      if (!currentWatermarks.has(sessionId)) {
        refuse();
      }
    }
  };
}

/** Capture original history expectations before the native media migration. */
export function captureOfflineSessionContent(database: DatabaseSync) {
  const version = readSqliteUserVersion(database);
  if (version !== 16 && version !== 19) {
    throw new Error("Offline original history accounting requires schema 16 or 19.");
  }
  // Native maintenance also repairs retired media found in current-schema data.
  const rewrittenSessions = new Map<string, bigint>();
  const expected = contentDigest(
    database,
    true,
    rewrittenSessions,
    createdHistoryTableFields(database, version),
  );
  const assertBindings = captureSessionBindings(database, rewrittenSessions);
  const assertMetadata = captureSessionMetadata(database, version);
  const assertSchema = captureSchemaMetadata(database, version);
  const assertProjections = captureOfflineSessionProjections(database, (raw) =>
    expectedMediaJson(raw, false),
  );
  return Object.freeze({
    assertPrepared(prepared: DatabaseSync): void {
      if (readSqliteUserVersion(prepared) !== 19 || contentDigest(prepared, false) !== expected) {
        throw new Error("Offline original history accounting failed.");
      }
      assertBindings(prepared);
      assertMetadata(prepared);
      assertSchema(prepared);
      assertProjections(prepared);
    },
  });
}
