import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  ensureMemoryChunkFtsSchema,
  ensureMemoryPathFtsSchema,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_PATH_FTS_TRIGGER_DEFINITIONS,
} from "../../packages/memory-host-sdk/src/host/memory-schema-fts.js";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import {
  assertSqliteSchemaContains,
  collectSqliteSchemaIssues,
  getCanonicalSqliteNamedIndexContracts,
  getCanonicalSqliteTableNames,
} from "../../src/infra/sqlite-schema-contract.js";
import { quoteSqliteIdentifier } from "../../src/infra/sqlite-schema-sql.js";
import { createVerifiedSqliteSnapshot } from "../../src/infra/sqlite-snapshot.js";
import { readSqliteUserVersion } from "../../src/infra/sqlite-user-version.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../src/state/openclaw-agent-db-contract.js";
import {
  assertOpenClawAgentDatabaseForMaintenance,
  assertOpenClawAgentDatabaseOwner,
} from "../../src/state/openclaw-agent-db-maintenance.js";
import { assertOpenClawAgentSchemaContains } from "../../src/state/openclaw-agent-db-schema-helpers.js";
import { withLegacySessionParticipantsSchema } from "../../src/state/openclaw-agent-participants-migration.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../src/state/openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../src/state/openclaw-state-schema.js";

// Rehearsal policy, not a backup/restore policy. Preserve all Session history,
// including cold archives and receipts without active-parent foreign keys.
const RETAIN = [
  "schema_meta",
  "session_nodes",
  "session_participants",
  "session_key_contract",
  "session_windows",
  "conversations",
  "session_conversations",
  "session_members",
  "session_suggestions",
  "board_tabs",
  "board_widgets",
  "session_progress_cards",
  "heartbeat_outcomes",
  "message_tool_run_outcomes",
  "session_goal_operations",
  "transcript_events",
  "session_transcript_archives",
  "transcript_rewrite_watermarks",
  "trajectory_runtime_events",
  "acp_parent_stream_events",
  "transcript_event_identities",
  "session_transcript_index_state",
  "session_transcript_active_events",
  "session_transcript_fts",
] as const;

// Children before parents; revision triggers run before their final state is cleared.
const CLEAR = [
  "state_leases", // Retired agent runtime storage; native migration removes it.
  "conversation_deliveries",
  "context_engine_turn_outbox",
  "cache_entries",
  "auth_profile_store",
  "auth_profile_state",
  "memory_index_meta",
  "memory_index_chunk_recall_metadata",
  "memory_index_chunk_provenance",
  "memory_index_chunks",
  "memory_index_sources",
  "memory_entry_origins",
  "memory_session_tombstones",
  "memory_embedding_cache",
  "standing_intents",
  "session_pending_inputs",
  "memory_index_state",
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  // Native media migration creates these; samples can contain excluded values.
  "sqlite_stat1",
  "sqlite_stat4",
] as const;

function schemaObjects(database: DatabaseSync) {
  return database
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
    .all();
}

function assertRehearsalSchema(database: DatabaseSync, agentId: string): Set<string> {
  assertOpenClawAgentDatabaseForMaintenance(database, { agentId, pathname: "offline source" });
  return assertClassifiedSchema(database, OPENCLAW_AGENT_SCHEMA_SQL);
}

/** Admit the original version before any migration can remove unknown storage. */
export function assertOfflineSessionOriginalSchema(database: DatabaseSync, agentId: string): void {
  assertOpenClawAgentDatabaseOwner(database, { agentId, pathname: "offline source" });
  const version = readSqliteUserVersion(database);
  if (version !== 16 && version !== 19) {
    throw new Error("Offline preparation requires reviewed source schema 16 or 19.");
  }
  const metadata = database
    .prepare("SELECT agent_id, schema_version FROM schema_meta WHERE meta_key='primary'")
    .get();
  if (metadata?.agent_id !== agentId || metadata.schema_version !== version) {
    throw new Error("Offline preparation requires exact original ownership and schema markers.");
  }
  let schemaSql =
    version === 16
      ? withLegacySessionParticipantsSchema(OPENCLAW_AGENT_SCHEMA_SQL)
      : OPENCLAW_AGENT_SCHEMA_SQL;
  if (schemaObjects(database).some((row) => row.name === "state_leases")) {
    schemaSql += retiredAgentLeaseSchema();
  }
  assertClassifiedSchema(database, schemaSql);
  assertOpenClawAgentSchemaContains(
    database,
    "offline original",
    originalSchemaRequirements(database, schemaSql),
    version === 16 ? "legacy" : "current",
  );
}

function retiredAgentLeaseSchema(): string {
  // The retired agent table shares the native lease contract; only its two
  // index names differ. Never derive an admission definition from source SQL.
  const startMarker = "CREATE TABLE IF NOT EXISTS state_leases (";
  const endMarker = "CREATE TABLE IF NOT EXISTS exec_approvals_config (";
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(startMarker);
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error("Offline retired lease policy requires reviewed native schema markers.");
  }
  const sql = OPENCLAW_STATE_SCHEMA_SQL.slice(start, end);
  if (sql.split("idx_state_leases_").length !== 3) {
    throw new Error("Offline retired lease policy requires exactly two native indexes.");
  }
  return sql.replaceAll("idx_state_leases_", "idx_agent_state_leases_");
}

function originalSchemaRequirements(database: DatabaseSync, schemaSql: string): string {
  // Project only trusted native DDL. Runtime opening installs these additive
  // objects before its assertion; admission must inspect without doing so.
  const objects = new Set(schemaObjects(database).map((row) => String(row.name)));
  const columns = new Set(
    database
      .prepare("PRAGMA table_info(session_nodes)")
      .all()
      .map((row) => String(row.name)),
  );
  let projected = schemaSql;
  const omit = (pattern: RegExp) => {
    if ([...projected.matchAll(pattern)].length !== 1) {
      throw new Error("Offline original schema projection requires reviewed native DDL.");
    }
    projected = projected.replace(pattern, "");
  };
  if (!columns.has("entry_valid")) {
    omit(
      /^ {2}entry_valid INTEGER NOT NULL DEFAULT 0 CHECK \(entry_valid IN \(-1, 0, 1\)\),\r?\n/gmu,
    );
  }
  if (!columns.has("project_id")) {
    omit(/^ {2}project_id TEXT,\r?\n/gmu);
  }
  if (!objects.has("session_key_contract")) {
    omit(
      /CREATE TABLE IF NOT EXISTS session_key_contract \([\s\S]*?\) STRICT;\s*INSERT OR IGNORE INTO session_key_contract[^;]*;/gu,
    );
  }
  for (const name of [
    "session_nodes_entry_valid_after_insert",
    "session_nodes_entry_valid_after_entry_update",
    "session_nodes_entry_valid_after_identity_update",
    "session_conversations_route_context_invalidate_after_update",
  ]) {
    if (!objects.has(name)) {
      omit(new RegExp(`CREATE TRIGGER IF NOT EXISTS ${name}\\b[\\s\\S]*?\\nEND;`, "gu"));
    }
  }
  // Native maintenance recreates absent explicit indexes. A present index,
  // including same-named drift, still receives the complete native check.
  for (const { name } of getCanonicalSqliteNamedIndexContracts(schemaSql)) {
    if (!objects.has(name)) {
      if (!/^[a-z0-9_]+$/u.test(name)) {
        throw new Error("Offline original index policy requires reviewed native names.");
      }
      omit(new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${name}\\b[^;]*;`, "gu"));
    }
  }
  return projected;
}

function assertClassifiedSchema(database: DatabaseSync, schemaSql: string): Set<string> {
  if (OPENCLAW_AGENT_SCHEMA_VERSION !== 19) {
    throw new Error("Offline Session policy requires reviewed schema 19.");
  }
  // Native compatibility admits some additive fields. Export cannot carry an
  // unclassified column, even when ordinary runtime reads safely tolerate it.
  if (
    collectSqliteSchemaIssues(database, schemaSql).some(
      (issue) => issue.code === "unexpected-column",
    )
  ) {
    throw new Error("Offline Session policy rejects unclassified columns.");
  }
  const canonical = openNodeSqliteDatabase(":memory:");
  try {
    canonical.exec(schemaSql);
    // The approved sources use these native default-tokenizer indexes. Build
    // their contracts with the owning module, never from source-provided SQL.
    ensureMemoryChunkFtsSchema({
      db: canonical,
      ftsTable: MEMORY_INDEX_FTS_TABLE,
      tokenizeClause: "",
    });
    ensureMemoryPathFtsSchema({ db: canonical, tokenizeClause: "" });
    canonical.exec("ANALYZE main");
    const canonicalObjects = schemaObjects(canonical);
    const actualObjects = schemaObjects(database);
    for (const name of [MEMORY_INDEX_FTS_TABLE, MEMORY_INDEX_PATHS_FTS_TABLE]) {
      const definition = canonicalObjects.find((row) => row.name === name)?.sql;
      if (typeof definition !== "string") {
        throw new Error("Native Memory index contract is unavailable.");
      }
      const members = new Set(getCanonicalSqliteTableNames(definition));
      if (name === MEMORY_INDEX_PATHS_FTS_TABLE) {
        for (const trigger of MEMORY_PATH_FTS_TRIGGER_DEFINITIONS) {
          members.add(trigger.name);
        }
      }
      // A shadow table or maintenance trigger without its root is not an
      // absent optional index: require the entire native table contract.
      if (actualObjects.some((row) => members.has(String(row.name)))) {
        assertSqliteSchemaContains(database, "offline Memory index", definition);
      }
    }
    const known = new Set(
      canonicalObjects.map((row) => JSON.stringify([row.type, row.name, row.tbl_name])),
    );
    if (
      schemaObjects(database).some(
        (row) => !known.has(JSON.stringify([row.type, row.name, row.tbl_name])),
      )
    ) {
      throw new Error("Offline Session policy rejects unclassified schema objects.");
    }
    for (const name of ["sqlite_stat1", "sqlite_stat4"]) {
      const actual = schemaObjects(database).find((row) => row.name === name);
      const expected = canonicalObjects.find((row) => row.name === name);
      if (actual && actual.sql !== expected?.sql) {
        throw new Error("Offline Session policy rejects noncanonical SQLite statistics.");
      }
    }
    const classified = new Set<string>([
      ...RETAIN,
      ...CLEAR,
      "standing_intents_fts",
      "sqlite_sequence",
    ]);
    const logicalTables = canonical.prepare("PRAGMA table_list").all();
    if (
      logicalTables.some(
        (row) =>
          row.schema === "main" &&
          row.type !== "shadow" &&
          row.name !== "sqlite_schema" &&
          !classified.has(String(row.name)),
      )
    ) {
      throw new Error("Offline Session table policy is incomplete.");
    }
  } finally {
    canonical.close();
  }
  const metadata = database.prepare("SELECT meta_key FROM schema_meta").all();
  if (metadata.length !== 1 || metadata[0]?.meta_key !== "primary") {
    throw new Error("Offline Session policy rejects unclassified metadata.");
  }
  const tables = new Set(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((row) => String(row.name)),
  );
  if (
    tables.has("sqlite_sequence") &&
    database
      .prepare(
        "SELECT 1 FROM sqlite_sequence WHERE name != 'session_pending_inputs' OR typeof(seq) != 'integer' OR seq < 0 LIMIT 1",
      )
      .get()
  ) {
    throw new Error("Offline Session policy rejects unclassified sequence state.");
  }
  return tables;
}

function typedValue(value: SQLOutputValue): unknown {
  if (value === null) {
    return ["null"];
  }
  if (value instanceof Uint8Array) {
    return ["blob", Buffer.from(value).toString("base64")];
  }
  return [typeof value, String(value)];
}

function retainedDigest(database: DatabaseSync, tables: Set<string>): string {
  const digest = createHash("sha256");
  digest.update(JSON.stringify(schemaObjects(database)));
  for (const table of [...RETAIN, "sqlite_sequence"]) {
    if (!tables.has(table)) {
      continue;
    }
    const quoted = quoteSqliteIdentifier(table);
    const fields = database
      .prepare(`SELECT * FROM ${quoted} LIMIT 0`)
      .columns()
      .map((column) => column.name);
    const fts = table === "session_transcript_fts";
    const order = fts ? "rowid" : fields.map(quoteSqliteIdentifier).join(",");
    const query = database.prepare(
      `SELECT ${fts ? "rowid AS export_rowid," : ""} * FROM ${quoted} ORDER BY ${order}`,
    );
    query.setReadBigInts(true);
    digest.update(JSON.stringify([table, fields]));
    for (const row of query.iterate()) {
      digest.update(
        JSON.stringify(Object.entries(row).map(([name, value]) => [name, typedValue(value)])),
      );
      digest.update("\n");
    }
  }
  return digest.digest("hex");
}

/** Export a prepared, current-schema agent copy for an offline import rehearsal. */
export async function createOfflineSessionSnapshot(options: {
  sourcePath: string;
  targetPath: string;
  agentId: string;
}): Promise<void> {
  let baseline: string | undefined;
  await createVerifiedSqliteSnapshot({
    sourcePath: options.sourcePath,
    targetPath: options.targetPath,
    requireNonEmptySource: true,
    validate(database) {
      const tables = assertRehearsalSchema(database, options.agentId);
      const current = retainedDigest(database, tables);
      if (baseline === undefined) {
        baseline = current;
        return;
      }
      if (current !== baseline) {
        throw new Error("Offline Session preservation check failed.");
      }
      for (const table of CLEAR) {
        if (
          tables.has(table) &&
          database.prepare(`SELECT 1 FROM ${quoteSqliteIdentifier(table)} LIMIT 1`).get()
        ) {
          throw new Error("Offline Session exclusion check failed.");
        }
      }
    },
    transform(database) {
      const tables = assertRehearsalSchema(database, options.agentId);
      database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;");
      try {
        for (const table of CLEAR) {
          if (tables.has(table)) {
            database.exec(`DELETE FROM ${quoteSqliteIdentifier(table)};`);
          }
        }
        // VACUUM preserves live FTS segments, including deleted tokens. Rebuild
        // every admitted index: keep current transcript rows/rowids, while
        // Memory and standing-intent indexes rebuild from their now-empty owners.
        for (const table of [
          "standing_intents_fts",
          "session_transcript_fts",
          MEMORY_INDEX_FTS_TABLE,
          MEMORY_INDEX_PATHS_FTS_TABLE,
        ]) {
          if (tables.has(table)) {
            const quoted = quoteSqliteIdentifier(table);
            database.exec(`INSERT INTO ${quoted}(${quoted}) VALUES ('rebuild');`);
          }
        }
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
  });
}
