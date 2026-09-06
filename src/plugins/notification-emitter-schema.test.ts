import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { getOpenClawStateRuntimeSchema } from "../state/openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { ensurePluginNotificationLedgerSchema } from "./notification-emitter-ledger.js";

describe("notification ledger canonical additive schema", () => {
  it("installs exactly the canonical first-use shape without changing the existing reader version", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const runtimeSchema = getOpenClawStateRuntimeSchema({
        includeVersionLazyAdditiveTables: false,
      });
      expect(runtimeSchema).not.toContain("plugin_notification_");
      // Raw SQL here is constant canonical fixture DDL, not a runtime data query.
      database.exec(runtimeSchema);
      database.exec("PRAGMA user_version = 15");
      ensurePluginNotificationLedgerSchema(database);
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
      database.close();
    }
  });
});
