import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  openEngineStore,
  withEngineStoreAdmission,
  type EngineConnection,
  type DatabaseEngineInput,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  getSqliteDatabaseAdmission,
  openNodeSqliteDatabase,
  publishSqliteDatabaseAdmission,
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  type SqliteDatabaseAdmissionKey,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { workboardEngineSchema } from "./store-engine-schema.js";
import { SCHEMA_VERSION, WORKBOARD_SCHEMA_SQL } from "./workboard-schema.js";
export type WorkboardSqlConnection = EngineConnection;

const WORKBOARD_SQLITE_BUSY_TIMEOUT_MS = 5000;
const WORKBOARD_SQLITE_DIR_MODE = 0o700;
const WORKBOARD_SQLITE_FILE_MODE = 0o600;
const schemaAdmission: SqliteDatabaseAdmissionKey<true> = {
  name: "workboard.schema",
  schemaDependent: true,
  read: (value) => (value === true ? true : undefined),
};

function tableColumns(db: DatabaseSync, tableName: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
}

const SOURCE_CREATION_COLUMNS = [
  "creation_idempotency_key",
  "creation_tenant",
  "creation_board_id",
  "creation_intent_json",
] as const;

export function ensureWorkboardSourceSchema(db: DatabaseSync): void {
  const columns = tableColumns(db, "workboard_cards");
  for (const column of SOURCE_CREATION_COLUMNS) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE workboard_cards ADD COLUMN ${column} TEXT`);
    }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS workboard_cards_creation_idempotency_idx
    ON workboard_cards(creation_tenant, creation_board_id, creation_idempotency_key)
    WHERE creation_idempotency_key IS NOT NULL`);
}

export function ensureWorkboardResultReviewSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workboard_result_reviews (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      board_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'reviewed', 'withdrawn')),
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      request_json TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS workboard_result_reviews_pending_card_idx
      ON workboard_result_reviews(tenant, board_id, card_id) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS workboard_result_reviews_card_idx
      ON workboard_result_reviews(tenant, board_id, card_id, created_at);
  `);
}

function ensureWorkboardSchema(db: DatabaseSync): void {
  if (getSqliteDatabaseAdmission(db, schemaAdmission)) {
    return;
  }
  db.exec(WORKBOARD_SCHEMA_SQL);
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(workboard_boards)")
      .all()
      .flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
  for (const column of ["automation_job_id", "kind", "sessions_spec"]) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE workboard_boards ADD COLUMN ${column} TEXT`);
    }
  }
  const migrationId = `schema-${SCHEMA_VERSION}`;
  const current = db
    .prepare("SELECT 1 AS found FROM workboard_schema_migrations WHERE id = ?")
    .get(migrationId);
  if (!current) {
    const columns = tableColumns(db, "workboard_cards");
    const retainedSourceColumns = SOURCE_CREATION_COLUMNS.filter((column) => columns.has(column));
    const schema = retainedSourceColumns.length
      ? WORKBOARD_SCHEMA_SQL.replace(
          "automation_json TEXT,",
          [
            "automation_json TEXT,",
            ...retainedSourceColumns.map((column) => `${column} TEXT,`),
          ].join(" "),
        )
      : WORKBOARD_SCHEMA_SQL;
    migrateSqliteSchemaToStrict(db, schema, { databaseLabel: "workboard database" });
    db.prepare(
      "INSERT OR IGNORE INTO workboard_schema_migrations (id, applied_at) VALUES (?, ?)",
    ).run(migrationId, Date.now());
  }
  publishSqliteDatabaseAdmission(db, schemaAdmission, true);
}

function chmodIfExists(targetPath: string, mode: number): void {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (err) {
    // SAFETY: chmodSync reports filesystem failures as Node errno exceptions.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function hardenWorkboardDatabaseFiles(dbPath: string): void {
  fs.chmodSync(path.dirname(dbPath), WORKBOARD_SQLITE_DIR_MODE);
  chmodIfExists(dbPath, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-wal`, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-shm`, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-journal`, WORKBOARD_SQLITE_FILE_MODE);
}

function prepareWorkboardDatabasePath(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: WORKBOARD_SQLITE_DIR_MODE });
  chmodIfExists(path.dirname(dbPath), WORKBOARD_SQLITE_DIR_MODE);
  if (!fs.existsSync(dbPath)) {
    fs.closeSync(fs.openSync(dbPath, "a", WORKBOARD_SQLITE_FILE_MODE));
  }
}

export function createWorkboardDatabase(
  dbPath: string,
  retainClose?: (close: () => void) => void,
  postgresInput?: DatabaseEngineInput,
): {
  db: WorkboardSqlConnection;
  close: () => void;
} {
  prepareWorkboardDatabasePath(dbPath);
  const db = openNodeSqliteDatabase(dbPath);
  let selected: EngineConnection | undefined;
  let maintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
  let maintenanceClosed = false;
  let databaseClosed = false;
  const close = () => {
    if (selected && selected !== db) {
      selected.close();
    }
    if (!maintenanceClosed) {
      maintenance?.close();
      maintenanceClosed = true;
    }
    if (!databaseClosed) {
      db.close();
      databaseClosed = true;
    }
  };
  try {
    retainClose?.(close);
    selected = withEngineStoreAdmission(() =>
      openEngineStore({
        anchor: db,
        schema: workboardEngineSchema,
        input: postgresInput,
        inspectSqlite: () => {
          admitSqliteSchema(db);
          const facts = getAdmittedSqliteSchemaFacts(db);
          if (!facts) {
            throw new Error("Workboard SQLite catalog admission is unavailable");
          }
          return {
            hasEngineAnchor: facts.tables.has("openclaw_engine_anchor"),
            hasExistingData:
              [...facts.tables].some(
                (name) => name !== "openclaw_engine_anchor" && !name.startsWith("sqlite_"),
              ) ||
              facts.views.size > 0 ||
              facts.triggers.size > 0,
          };
        },
        prepareAnchor: () => {
          maintenance = configureSqliteConnectionPragmas(db, {
            busyTimeoutMs: WORKBOARD_SQLITE_BUSY_TIMEOUT_MS,
            checkpointIntervalMs: 0,
            databaseLabel: "workboard database",
            databasePath: dbPath,
            foreignKeys: true,
            synchronous: "NORMAL",
          });
        },
        openSqlite: () => ensureWorkboardSchema(db),
      }),
    );
    hardenWorkboardDatabaseFiles(dbPath);
    return { db: selected, close };
  } catch (error) {
    if (!retainClose) {
      try {
        if (selected && selected !== db) {
          selected.close();
        }
        maintenance?.close();
      } finally {
        db.close();
      }
    }
    throw error;
  }
}
