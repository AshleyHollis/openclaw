// Built candidate entrypoint regressions: never substitute a mocked Doctor.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import {
  createBuiltRuntime,
  seedPluginStateSidecar,
  seedV17AdditiveRepairDatabase,
} from "./doctor-config-preflight.process.test-support.js";

const fixtures = createFixtureLifetime();
afterAll(() => fixtures.cleanup());

async function candidate(name: string, activation: boolean) {
  const runtimeRoot = createBuiltRuntime(fixtures.createTempDir(`container-upgrade-${name}-`), path.resolve("dist"), { copyDirectories: true });
  for (const file of ["openclaw.mjs", "docker-entrypoint.mjs"]) {
    fs.copyFileSync(path.resolve(file), path.join(runtimeRoot, file));
  }
  return await createOpenClawTestInstance({
    name,
    cwd: runtimeRoot,
    // Exactly the stock image command, through its actual activation adapter.
    entrypoint: activation
      ? [path.join(runtimeRoot, "docker-entrypoint.mjs"), process.execPath, path.join(runtimeRoot, "openclaw.mjs")]
      : [path.join(runtimeRoot, "openclaw.mjs")],
    startTimeoutMs: 60_000,
    stopTimeoutMs: 5_000,
    env: {
      NODE_ENV: undefined, OPENCLAW_HOME: undefined, VITEST: undefined,
      OPENCLAW_TEST_FAST: "1", OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external", NO_COLOR: "1",
    },
  });
}

it("stock activation repairs retained config and historical SQLite, reopens without losing fixture identities", async () => {
  const instance = await candidate("stock-upgrade", true);
  try {
    await instance.state.writeConfig({
      meta: { lastTouchedVersion: "2026.9.7" },
      agents: { defaults: { heartbeat: { skipWhenBusy: true } }, list: [{ id: "main" }] },
      gateway: { mode: "local", port: instance.port, auth: { mode: "none" } },
    });
    // 9.7 and 9.8 both declare shared19/agent24. Also exercise older additive
    // state still supported by the installed Doctor, not a relabelled 9.7 DB.
    seedPluginStateSidecar(instance.stateDir, 9_700);
    const agentPath = seedV17AdditiveRepairDatabase(instance.stateDir);
    const sidecar = path.join(instance.stateDir, "plugin-state", "state.sqlite");
    const originalSidecar = fs.readFileSync(sidecar);
    const folder = path.join(instance.stateDir, "fixture-notes", "fictional-topic");
    fs.mkdirSync(folder, { recursive: true });
    const markerPath = path.join(folder, ".command-center-folder-identity");
    const marker = '{"version":1,"id":"12345678-1234-4123-8123-123456789abc"}\n';
    const notePath = path.join(folder, "note.md");
    fs.writeFileSync(markerPath, marker);
    fs.writeFileSync(notePath, "Fictional retained note.\n");
    const readRows = () => {
      const db = new DatabaseSync(path.join(instance.stateDir, "state", "openclaw.sqlite"), { readOnly: true });
      try {
        return db.prepare("SELECT value_json, created_at FROM plugin_state_entries WHERE plugin_id = 'discord' AND entry_key = 'interaction:1'").get();
      } finally { db.close(); }
    };
    for (let pass = 0; pass < 2; pass++) {
      await instance.startGateway();
      const response = await fetch(`http://127.0.0.1:${instance.port}/readyz`);
      expect(response.status, instance.logs()).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ready: true, failing: [] });
      expect(readRows()).toEqual({ value_json: '{"ok":false}', created_at: 9_700 });
      expect(fs.readFileSync(sidecar)).toEqual(originalSidecar);
      expect(fs.readFileSync(markerPath, "utf8")).toBe(marker);
      expect(fs.readFileSync(notePath, "utf8")).toBe("Fictional retained note.\n");
      await instance.stopGateway();
    }
    const db = new DatabaseSync(agentPath, { readOnly: true });
    try { expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(24); }
    finally { db.close(); }
    expect(JSON.parse(fs.readFileSync(instance.configPath, "utf8")).agents?.defaults?.heartbeat?.skipWhenBusy).toBeUndefined();
    // Folder bytes/UUID conservation is not Btrfs re-binding or CC discoverability proof.
  } finally { await instance.cleanup(); }
}, 180_000);

it("bypassing activation does not silently perform Doctor's config repair", async () => {
  const instance = await candidate("custom-command-bypass", false);
  try {
    await instance.state.writeConfig({
      agents: { defaults: { heartbeat: { skipWhenBusy: true } }, list: [{ id: "main" }] },
      gateway: { mode: "local", port: instance.port, auth: { mode: "none" } },
    });
    const original = fs.readFileSync(instance.configPath);
    await expect(instance.startGateway()).rejects.toThrow();
    expect(instance.logs()).toMatch(/skipWhenBusy/);
    expect(instance.logs()).toMatch(/invalid|unrecognized|unknown|unsupported/i);
    expect(fs.readFileSync(instance.configPath)).toEqual(original);
  } finally { await instance.cleanup(); }
}, 90_000);

it("failed SQLite admission prevents readiness and conserves unsupported database bytes", async () => {
  const instance = await candidate("migration-refusal", true);
  try {
    await instance.state.writeConfig({ gateway: { mode: "local", port: instance.port, auth: { mode: "none" } } });
    const agentPath = seedV17AdditiveRepairDatabase(instance.stateDir);
    const db = new DatabaseSync(agentPath);
    try {
      db.exec("PRAGMA user_version = 999");
      db.prepare("UPDATE schema_meta SET schema_version = 999 WHERE meta_key = 'primary'").run();
    } finally { db.close(); }
    const original = fs.readFileSync(agentPath);
    await expect(instance.startGateway()).rejects.toThrow();
    expect(instance.logs()).toMatch(/uses schema 999; this build supports 24/);
    expect(fs.readFileSync(agentPath)).toEqual(original);
    expect(instance.readiness.some(item => item.outcome === "ready")).toBe(false);
  } finally { await instance.cleanup(); }
}, 90_000);
