// Durable, host-owned notification ledger. Plugin code receives only the emitter facade.
import { createHash, randomUUID } from "node:crypto";
import type { Insertable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { ensureColumn } from "../state/openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type {
  PluginNotificationClearResult,
  PluginNotificationEmitResult,
  PluginNotificationLedger,
  PluginNotificationPrincipal,
} from "./notification-emitter.js";

const RATE_WINDOW_MS = 60_000;
const RETENTION_MS = 30 * 86_400_000;
const ensured = new WeakSet<object>();

type LedgerDatabase = Pick<
  import("../state/openclaw-state-db.generated.js").DB,
  | "plugin_notification_emissions"
  | "plugin_notification_delivery_attempts"
  | "plugin_notification_clear_attempts"
  | "plugin_notification_clear_operations"
>;

function stateOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {};
}

function principalKey(principal: PluginNotificationPrincipal): string {
  // Credential generations authorize each operation but do not own it. Keeping
  // durable records operator/plugin-scoped preserves dedupe and clearing after rotation.
  return createHash("sha256")
    .update(
      JSON.stringify({
        operatorId: principal.operatorId,
        pluginId: principal.pluginId,
      }),
    )
    .digest("hex");
}

function parseEmitResult(value: string | null): PluginNotificationEmitResult | null {
  if (!value) {
    return null;
  }
  try {
    // SAFETY: every required field is checked below before the complete result is returned.
    const result = JSON.parse(value) as Partial<PluginNotificationEmitResult>;
    return typeof result.status === "string" &&
      typeof result.attempted === "number" &&
      typeof result.delivered === "number" &&
      typeof result.failed === "number" &&
      typeof result.ambiguous === "number"
      ? // SAFETY: the preceding predicate validates every required persisted result field.
        (result as PluginNotificationEmitResult) // SAFETY: the preceding predicate validates every field.
      : null;
  } catch {
    return null;
  }
}

function ensurePluginNotificationLedgerSchema(db: Parameters<typeof getNodeSqliteKysely>[0]): void {
  if (ensured.has(db)) {
    return;
  }
  /* sqlite-allow-raw: additive STRICT-table schema DDL is a closed, constant host-owned script. */
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
      attempt_id TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (principal_key, plugin_id, logical_operation_id, target_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS plugin_notification_clear_operations (
      principal_key TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      logical_operation_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (principal_key, plugin_id, logical_operation_id)
    ) STRICT;
  `);
  ensureColumn(db, "plugin_notification_clear_attempts", "attempt_id TEXT");
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
    kysely.deleteFrom("plugin_notification_clear_attempts").where("updated_at_ms", "<", cutoff),
  );
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("plugin_notification_clear_operations").where("updated_at_ms", "<", cutoff),
  );
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("plugin_notification_delivery_attempts").where("updated_at_ms", "<", cutoff),
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
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        ensurePluginNotificationLedgerSchema(db);
        return run(db);
      },
      { ...options, database },
    );
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
        if (
          existing.declaration_id !== params.declarationId ||
          existing.candidate_hash !== params.candidateHash
        ) {
          return { kind: "conflict" as const };
        }
        const result = parseEmitResult(existing.result_json);
        return result ? { kind: "replay" as const, result } : { kind: "in-flight" as const };
      }
      const clearedOperation = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("plugin_notification_clear_operations")
          .select("logical_operation_id")
          .where("principal_key", "=", key)
          .where("plugin_id", "=", params.principal.pluginId)
          .where("logical_operation_id", "=", params.logicalOperationId),
      );
      // A durable clear closes the whole logical operation. Do not let a retry
      // create a new delivery after the operator has already cleared it.
      if (clearedOperation) {
        return { kind: "cleared" as const };
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
      executeSqliteQuerySync(
        db,
        kysely.insertInto("plugin_notification_emissions").values(emission),
      );
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

  completeEmission(
    params: Parameters<PluginNotificationLedger["completeEmission"]>[0],
  ): readonly string[] {
    const key = principalKey(params.principal);
    return this.transaction((db) => {
      const kysely = getNodeSqliteKysely<LedgerDatabase>(db);
      const emission = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("plugin_notification_emissions")
          .select("logical_operation_id")
          .where("principal_key", "=", key)
          .where("plugin_id", "=", params.principal.pluginId)
          .where("emission_id", "=", params.emissionId),
      );
      if (!emission) {
        return [];
      }
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
          .set({
            state: "complete",
            result_json: JSON.stringify(params.result),
            updated_at_ms: params.nowMs,
          })
          .where("principal_key", "=", key)
          .where("plugin_id", "=", params.principal.pluginId)
          .where("emission_id", "=", params.emissionId),
      );
      const clearedOperation = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("plugin_notification_clear_operations")
          .select("logical_operation_id")
          .where("principal_key", "=", key)
          .where("plugin_id", "=", params.principal.pluginId)
          .where("logical_operation_id", "=", emission.logical_operation_id),
      );
      const reClearTargetIds = clearedOperation
        ? [...params.outcomes]
            .filter(([, outcome]) => outcome === "accepted" || outcome === "ambiguous")
            .map(([targetId]) => targetId)
            .toSorted()
        : [];
      // Transport I/O happens outside the transaction, so a clear can finish
      // before this send. Invalidate earlier completions before the re-clear claim.
      for (const targetId of reClearTargetIds) {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("plugin_notification_clear_attempts")
            .set({
              outcome: "in-flight",
              result_json: null,
              attempt_id: null,
              updated_at_ms: params.nowMs,
            })
            .where("principal_key", "=", key)
            .where("plugin_id", "=", params.principal.pluginId)
            .where("logical_operation_id", "=", emission.logical_operation_id)
            .where("target_id", "=", targetId),
        );
      }
      return reClearTargetIds;
    });
  }

  claimClear(params: Parameters<PluginNotificationLedger["claimClear"]>[0]) {
    const key = principalKey(params.principal);
    const attemptId = randomUUID();
    return this.transaction((db) => {
      const kysely = getNodeSqliteKysely<LedgerDatabase>(db);
      deleteExpiredRows(db, kysely, params.nowMs);
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("plugin_notification_clear_operations")
          .values({
            principal_key: key,
            plugin_id: params.principal.pluginId,
            logical_operation_id: params.logicalOperationId,
            created_at_ms: params.nowMs,
            updated_at_ms: params.nowMs,
          })
          .onConflict((conflict) =>
            conflict.columns(["principal_key", "plugin_id", "logical_operation_id"]).doUpdateSet({
              updated_at_ms: params.nowMs,
            }),
          ),
      );
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
        const clearedTargetIds = existing
          .filter((row) => row.outcome === "accepted")
          .map((row) => row.target_id)
          .toSorted();
        const targetIds = existing
          .filter((row) => row.outcome !== "accepted")
          .map((row) => row.target_id)
          .toSorted();
        if (targetIds.length === 0) {
          return {
            kind: "replay" as const,
            result: {
              status: "cleared" as const,
              attempted: clearedTargetIds.length,
              cleared: clearedTargetIds.length,
              failed: 0,
              ambiguous: 0,
            },
          };
        }
        // Clear delivery is idempotent. An in-flight row is a crash-recovery
        // marker, not an exclusive lease, so a restarted host can reclaim it.
        for (const targetId of targetIds) {
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("plugin_notification_clear_attempts")
              .set({
                outcome: "in-flight",
                result_json: null,
                attempt_id: attemptId,
                updated_at_ms: params.nowMs,
              })
              .where("principal_key", "=", key)
              .where("plugin_id", "=", params.principal.pluginId)
              .where("logical_operation_id", "=", params.logicalOperationId)
              .where("target_id", "=", targetId),
          );
        }
        return { kind: "claimed" as const, attemptId, targetIds, clearedTargetIds };
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
          result: {
            status: "already-cleared" as const,
            attempted: 0,
            cleared: 0,
            failed: 0,
            ambiguous: 0,
          },
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
            attempt_id: attemptId,
            created_at_ms: params.nowMs,
            updated_at_ms: params.nowMs,
          })),
        ),
      );
      return { kind: "claimed" as const, attemptId, targetIds, clearedTargetIds: [] };
    });
  }

  completeClear(
    params: Parameters<PluginNotificationLedger["completeClear"]>[0],
  ): PluginNotificationClearResult {
    const key = principalKey(params.principal);
    return this.transaction((db) => {
      const kysely = getNodeSqliteKysely<LedgerDatabase>(db);
      for (const [targetId, outcome] of params.outcomes) {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("plugin_notification_clear_attempts")
            .set({ outcome, updated_at_ms: params.nowMs })
            .where("principal_key", "=", key)
            .where("plugin_id", "=", params.principal.pluginId)
            .where("logical_operation_id", "=", params.logicalOperationId)
            .where("target_id", "=", targetId)
            .where("attempt_id", "=", params.attemptId),
        );
      }
      // Read after fencing in the same transaction: an ignored stale response
      // must not claim success over a newer failed or still-running attempt.
      const rows = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("plugin_notification_clear_attempts")
          .select("outcome")
          .where("principal_key", "=", key)
          .where("plugin_id", "=", params.principal.pluginId)
          .where("logical_operation_id", "=", params.logicalOperationId),
      ).rows;
      if (rows.length === 0) {
        return { status: "ambiguous", attempted: 0, cleared: 0, failed: 0, ambiguous: 1 };
      }
      const cleared = rows.filter((row) => row.outcome === "accepted").length;
      const failed = rows.filter((row) => row.outcome === "failed").length;
      const ambiguous = rows.length - cleared - failed;
      return {
        status: ambiguous ? "ambiguous" : failed ? "partial" : "cleared",
        attempted: rows.length,
        cleared,
        failed,
        ambiguous,
      };
    });
  }
}
