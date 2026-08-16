import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";

describe("OpenClaw state runtime schema projection", () => {
  it("omits lazy additive tables and their unique indexes before first use", () => {
    const schema = getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false });

    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS cron_run_receipts");
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS worker_session_placement_moves");
    expect(schema).not.toContain("idx_cron_run_receipts_active_job");
    expect(schema).not.toContain("idx_cron_run_receipts_job_history");
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS outbound_message_progress");
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS outbound_message_execution_bindings");
    expect(schema).not.toContain("outbound_message_execution_bindings_execution_event_idx");
    expect(schema).not.toContain("outbound_message_progress_occurred_idx");
    expect(schema).not.toContain("outbound_message_progress_run_occurred_idx");
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS github_publication_requests");
    expect(schema).not.toContain("idx_github_publication_requests_pending");
    expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS config_revision_keys");
  });

  it("projects an executable schema when notification ledger tables stay lazy", () => {
    const schema = getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false });
    const database = new DatabaseSync(":memory:");

    try {
      expect(() => database.exec(schema)).not.toThrow();
      for (const name of [
        "plugin_notification_emissions",
        "plugin_notification_delivery_attempts",
        "plugin_notification_clear_attempts",
        "plugin_notification_clear_operations",
        "plugin_notification_device_associations",
        "idx_plugin_notification_emissions_rate",
        "idx_plugin_notification_emissions_retention",
        "idx_plugin_notification_delivery_operations",
        "idx_plugin_notification_device_associations_owner",
      ]) {
        expect(schema).not.toContain(name);
      }
    } finally {
      database.close();
    }
  });
});
