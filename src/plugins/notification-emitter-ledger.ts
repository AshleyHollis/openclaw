// Durable, host-owned notification ledger. Plugin code receives only the emitter facade.
import { createHash } from "node:crypto";
import type { Insertable } from "kysely";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type {
  PluginNotificationAttemptOutcome,
  PluginNotificationClearResult,
  PluginNotificationEmitResult,
  PluginNotificationLedger,
  PluginNotificationPrincipal,
} from "./notification-emitter.js";

const RATE_WINDOW_MS = 60_000;
const RETENTION_MS = 30 * 86_400_000;
const ensured = new WeakSet<object>();

type LedgerDatabase = {
  plugin_notification_emissions: {
    principal_key: string;
    operator_id: string;
    plugin_id: string;
    emission_id: string;
    declaration_id: string;
    logical_operation_id: string;
    candidate_hash: string;
    expires_at_ms: number;
    state: string;
    result_json: string | null;
    created_at_ms: number;
    updated_at_ms: number;
  };
  plugin_notification_delivery_attempts: {
    principal_key: string;
    plugin_id: string;
    emission_id: string;
    logical_operation_id: string;
    target_id: string;
    outcome: string;
    created_at_ms: number;
    updated_at_ms: number;
  };
  plugin_notification_clear_attempts: {
    principal_key: string;
    plugin_id: string;
    logical_operation_id: string;
    target_id: string;
    outcome: string;
    result_json: string | null;
    created_at_ms: number;
    updated_at_ms: number;
  };
};

function stateOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {};
}

function principalKey(principal: PluginNotificationPrincipal): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operatorId: principal.operatorId,
        pluginId: principal.pluginId,
        authenticationMethod: principal.authenticationMethod,
        authenticationGeneration: principal.authenticationGeneration,
        pairedDeviceId: principal.pairedDeviceId,
        pairingGeneration: principal.pairingGeneration,
        issuerGeneration: principal.issuerGeneration ?? null,
        scopes: [...principal.scopes].toSorted(),
      }),
    )
    .digest("hex");
}

function parseEmitResult(value: string | null): PluginNotificationEmitResult | null {
  if (!value) return null;
  try {
    const result = JSON.parse(value) as Partial<PluginNotificationEmitResult>;
    return typeof result.status === "string" &&
      typeof result.attempted === "number" &&
      typeof result.delivered === "number" &&
      typeof result.failed === "number" &&
      typeof result.ambiguous === "number"
      ? (result as PluginNotificationEmitResult)
      : null;
  } catch {
    return null;
  }
}

function parseClearResult(value: string | null): PluginNotificationClearResult | null {
  if (!value) return null;
  try {
    const result = JSON.parse(value) as Partial<PluginNotificationClearResult>;
    return typeof result.status === "string" &&
      typeof result.attempted === "number" &&
      typeof result.cleared === "number" &&
      typeof result.failed === "number" &&
      typeof result.ambiguous === "number"
      ? (result as PluginNotificationClearResult)
      : null;
  } catch {
    return null;
  }
}

export function ensurePluginNotificationLedgerSchema(
  db: Parameters<typeof getNodeSqliteKysely>[0],
): void {
  if (ensured.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_notification_emissions (
      principal_key TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      emission_id TEXT NOT NULL,
      declaration_id TEXT NOT NULL,
      logical_operation_id TEXT NOT NULL,
      candidate_hash TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      state TEXT NOT NULL,
      result_json TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (principal_key, plugin_id, emission_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_plugin_notification_emissions_rate
      ON plugin_notification_emissions(operator_id, plugin_id, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_plugin_notification_emissions_retention
      ON plugin_notification_emissions(updated_at_ms, expires_at_ms);
    CREATE TABLE IF NOT EXISTS plugin_notification_delivery_attempts (
      principal_key TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      emission_id TEXT NOT NULL,
      logical_operation_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (principal_key, plugin_id, emission_id, target_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_plugin_notification_delivery_operations
      ON plugin_notification_delivery_attempts(principal_key, plugin_id, logical_operation_id, target_id);
    CREATE TABLE IF NOT EXISTS plugin_notification_clear_attempts (
      principal_key TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      logical_operation_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      result_json TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (principal_key, plugin_id, logical_operation_id, target_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS plugin_notification_device_associations (
      target_id TEXT NOT NULL PRIMARY KEY,
      target_kind TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      authentication_method TEXT NOT NULL,
      authentication_generation TEXT NOT NULL,
      paired_device_id TEXT NOT NULL,
      pairing_generation TEXT NOT NULL,
      issuer_generation TEXT,
      scopes_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_plugin_notification_device_associations_owner
      ON plugin_notification_device_associations(operator_id, authentication_generation, target_kind);
  `);
  ensured.add(db);
}

function deleteExpiredRows(
  db: Parameters<typeof getNodeSqliteKysely>[0],
  kysely: ReturnType<typeof getNodeSqliteKysely<LedgerDatabase>>,
  nowMs: number,
): void {
  const cutoff = nowMs - RETENTION_MS;
  // Retention starts only after the terminal record is well past both its expiry and retry value.
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("plugin_notification_clear_attempts")
      .where("updated_at_ms", "<", cutoff),
  );
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("plugin_notification_delivery_attempts")
      .where("updated_at_ms", "<", cutoff),
  );
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("plugin_notification_emissions")
      .where("updated_at_ms", "<", cutoff)
      .where("expires_at_ms", "<", cutoff),
  );
}

/** Shared SQLite implementation. All state claims are synchronous and finish before network I/O. */
export class SqlitePluginNotificationLedger implements PluginNotificationLedger {
  constructor(private readonly options: { stateDir?: string } = {}) {}

  private transaction<T>(run: (db: Parameters<typeof getNodeSqliteKysely>[0]) => T): T {
    const options = stateOptions(this.options.stateDir);
    const database = openOpenClawStateDatabase(options);
    return runOpenClawStateWriteTransaction(({ db }) => {
      ensurePluginNotificationLedgerSchema(db);
      return run(db);
    }, { ...options, database });
  }

  claimEmission(params: Parameters<PluginNotificationLedger["claimEmission"]>[0]) {
    const key = principalKey(params.principal);
    return this.transaction((db) => {
      const kysely = getNodeSqliteKysely<LedgerDatabase>(db);
      deleteExpiredRows(db, kysely, params.nowMs);
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("plugin_notification_emissions")
          .selectAll()
          .where("principal_key", "=", key)
          .where("plugin_id", "=", params.principal.pluginId)
          .where("emission_id", "=", params.emissionId),
      );
      if (existing) {
        if (existing.candidate_hash !== params.candidateHash) return { kind: "conflict" as const };
        const result = parseEmitResult(existing.result_json);
        return result ? { kind: "replay" as const, result } : { kind: "in-flight" as const };
      }
      const rateRows = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("plugin_notification_emissions")
          .select("created_at_ms")
          .where("operator_id", "=", params.principal.operatorId)
          .where("plugin_id", "=", params.principal.pluginId)
          .where("created_at_ms", ">", params.nowMs - RATE_WINDOW_MS),
      ).rows;
      if (rateRows.length >= 12) {
        const first = Math.min(...rateRows.map((row) => row.created_at_ms));
        return {
          kind: "rate-limited" as const,
          retryAfterMs: Math.max(1, first + RATE_WINDOW_MS - params.nowMs),
        };
      }
      const emission: Insertable<LedgerDatabase["plugin_notification_emissions"]> = {
        principal_key: key,
        operator_id: params.principal.operatorId,
        plugin_id: params.principal.pluginId,
        emission_id: params.emissionId,
        declaration_id: params.declarationId,
        logical_operation_id: params.logicalOperationId,
        candidate_hash: params.candidateHash,
        expires_at_ms: params.expiresAtMs,
        state: "in-flight",
        result_json: null,
        created_at_ms: params.nowMs,
        updated_at_ms: params.nowMs,
      };
      executeSqliteQuerySync(db, kysely.insertInto("plugin_notification_emissions").values(emission));
      const targetIds = [...new Set(params.targetIds)].toSorted();
      if (targetIds.length > 0) {
        executeSqliteQuerySync(
          db,
          kysely.insertInto("plugin_notification_delivery_attempts").values(
            targetIds.map((targetId) => ({
              principal_key: key,
              plugin_id: params.principal.pluginId,
              emission_id: params.emissionId,
              logical_operation_id: params.logicalOperationId,
              target_id: targetId,
              outcome: "in-flight",
              created_at_ms: params.nowMs,
              updated_at_ms: params.nowMs,
            })),
          ),
        );
      }
      return { kind: "claimed" as const, targetIds };
    });
  }

  completeEmission(params: Parameters<PluginNotificationLedger["completeEmission"]>[0]): void {
    const key = principalKey(params.principal);
    this.transaction((db) => {
      const kysely = getNodeSqliteKysely<LedgerDatabase>(db);
      for (const [targetId, outcome] of params.outcomes) {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("plugin_notification_delivery_attempts")
            .set({ outcome, updated_at_ms: params.nowMs })
            .where("principal_key", "=", key)
            .where("plugin_id", "=", params.principal.pluginId)
            .where("emission_id", "=", params.emissionId)
            .where("target_id", "=", targetId),
        );
      }
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("plugin_notification_emissions")
          .set({ state: "complete", result_json: JSON.stringify(params.result), updated_at_ms: params.nowMs })
          .where("principal_key", "=", key)
          .where("plugin_id", "=", params.principal.pluginId)
          .where("emission_id", "=", params.emissionId),
      );
    });
  }

  claimClear(params: Parameters<PluginNotificationLedger["claimClear"]>[0]) {
    const key = principalKey(params.principal);
    return this.transaction((db) => {
      const kysely = getNodeSqliteKysely<LedgerDatabase>(db);
      deleteExpiredRows(db, kysely, params.nowMs);
      const existing = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("plugin_notification_clear_attempts")
          .selectAll()
          .where("principal_key", "=", key)
          .where("plugin_id", "=", params.principal.pluginId)
          .where("logical_operation_id", "=", params.logicalOperationId),
      ).rows;
      if (existing.length > 0) {
        const result = parseClearResult(existing[0]?.result_json ?? null);
        return result ? { kind: "replay" as const, result } : { kind: "in-flight" as const };
      }
      const deliveries = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("plugin_notification_delivery_attempts")
          .select("target_id")
          .where("principal_key", "=", key)
          .where("plugin_id", "=", params.principal.pluginId)
          .where("logical_operation_id", "=", params.logicalOperationId)
          .distinct(),
      ).rows;
      const targetIds = deliveries.map((row) => row.target_id).toSorted();
      if (targetIds.length === 0) {
        return {
          kind: "replay" as const,
          result: { status: "already-cleared" as const, attempted: 0, cleared: 0, failed: 0, ambiguous: 0 },
        };
      }
      executeSqliteQuerySync(
        db,
        kysely.insertInto("plugin_notification_clear_attempts").values(
          targetIds.map((targetId) => ({
            principal_key: key,
            plugin_id: params.principal.pluginId,
            logical_operation_id: params.logicalOperationId,
            target_id: targetId,
            outcome: "in-flight",
            result_json: null,
            created_at_ms: params.nowMs,
            updated_at_ms: params.nowMs,
          })),
        ),
      );
      return { kind: "claimed" as const, targetIds };
    });
  }

  completeClear(params: Parameters<PluginNotificationLedger["completeClear"]>[0]): void {
    const key = principalKey(params.principal);
    this.transaction((db) => {
      const kysely = getNodeSqliteKysely<LedgerDatabase>(db);
      for (const [targetId, outcome] of params.outcomes) {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("plugin_notification_clear_attempts")
            .set({ outcome, result_json: JSON.stringify(params.result), updated_at_ms: params.nowMs })
            .where("principal_key", "=", key)
            .where("plugin_id", "=", params.principal.pluginId)
            .where("logical_operation_id", "=", params.logicalOperationId)
            .where("target_id", "=", targetId),
        );
      }
    });
  }
}
