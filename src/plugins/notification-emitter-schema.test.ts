import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { getOpenClawStateRuntimeSchema } from "../state/openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { VERSION } from "../version.js";
import { SqlitePluginNotificationLedger } from "./notification-emitter-ledger.js";

describe("notification ledger canonical additive schema", () => {
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );

  it("installs exactly the canonical first-use shape without changing the existing reader version", () => {
    const stateDir = dirs.make("notification-schema-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const pathname = resolveOpenClawStateSqlitePath(env);
    mkdirSync(path.dirname(pathname), { recursive: true });
    const runtimeSchema = getOpenClawStateRuntimeSchema({
      includeVersionLazyAdditiveTables: false,
    });
    expect(runtimeSchema).not.toContain("plugin_notification_");
    const previous = new DatabaseSync(pathname);
    try {
      // Raw SQL here is constant canonical fixture DDL, not a runtime data query.
      previous.exec(runtimeSchema);
      previous.exec("PRAGMA user_version = 15");
      previous
        .prepare(`
        INSERT INTO schema_meta
          (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
        VALUES ('primary', 'global', 15, NULL, ?, 1, 1)
      `)
        .run(VERSION);
    } finally {
      previous.close();
    }
    const { db: database } = openOpenClawStateDatabase({ env });
    try {
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'plugin_notification_%'")
          .all(),
      ).toEqual([]);
      const ledger = new SqlitePluginNotificationLedger({ stateDir });
      expect(
        ledger.claimClear({
          principal: {
            operatorId: "operator@example.test",
            pluginId: "example",
            authenticationMethod: "device-token",
            authenticationGeneration: "authentication-1",
            pairedDeviceId: "browser-1",
            pairingGeneration: "pairing-1",
            scopes: ["operator.read"],
          },
          logicalOperationId: "clear-before-first-emission",
          nowMs: 1,
        }),
      ).toEqual({
        kind: "replay",
        result: { status: "already-cleared", attempted: 0, cleared: 0, failed: 0, ambiguous: 0 },
      });
      const notificationSchema = OPENCLAW_STATE_SCHEMA_SQL.slice(
        OPENCLAW_STATE_SCHEMA_SQL.indexOf(
          "CREATE TABLE IF NOT EXISTS plugin_notification_emissions",
        ),
      );
      expect(() =>
        assertSqliteSchemaContains(database, "notification ledger", notificationSchema),
      ).not.toThrow();
      // The unchanged older-reader contract explicitly tolerates unrelated additive tables.
      expect(() =>
        assertSqliteSchemaContains(database, "pre-notification reader", runtimeSchema),
      ).not.toThrow();
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });
});
