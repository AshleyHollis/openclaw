import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { loadPluginManifest } from "./manifest.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

function fixture(controlUi: unknown) {
  const plugin = writePlugin({
    id: "native-ui",
    body: 'module.exports = { id: "native-ui", register() {} };',
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: plugin.id,
      configSchema: { type: "object", additionalProperties: false },
      controlUi,
    }),
  );
  return plugin;
}

describe("native Control UI manifest", () => {
  it.each([
    { path: "/plugins/other/notes" },
    { path: "/plugins/native-ui/notes?all=1" },
    { path: "/plugins/native-ui/%2e%2e/notes" },
    { path: "https://example.invalid/notes" },
    { method: "DELETE" },
    { method: "GET", maxRequestBytes: 1 },
    { maxRequestBytes: 12582913 },
    { maxResponseBytes: 1048577 },
    { maxResponseBytes: 0 },
    { maxRequestBytes: 0.5 },
    { headers: { authorization: "not-allowed" } },
  ])("rejects invalid HTTP route authority %j", (override) => {
    const route = {
      path: "/plugins/native-ui/notes",
      method: "POST",
      maxRequestBytes: 1024,
      maxResponseBytes: 32768,
      ...override,
    };
    expect(
      loadPluginManifest(fixture({ entry: "dist/control-ui/index.js", httpRoutes: [route] }).dir),
    ).toMatchObject({ ok: false, error: expect.stringContaining("controlUi") });
  });

  it("carries normalized built entrypoints through discovery into runtime ownership", () => {
    useNoBundledPlugins();
    const plugin = fixture({
      entry: "./dist/control-ui/index.js",
      styles: ["./dist/control-ui/theme.css", "dist/control-ui/theme.css"],
      httpRoutes: [
        {
          path: "/plugins/native-ui/notes",
          method: "POST",
          maxRequestBytes: 12582912,
          maxResponseBytes: 32768,
        },
      ],
    });
    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: { plugins: { load: { paths: [plugin.file] }, allow: [plugin.id] } },
      onlyPluginIds: [plugin.id],
    });
    expect(registry.plugins.find((record) => record.id === plugin.id)).toMatchObject({
      status: "loaded",
      controlUi: {
        entry: "dist/control-ui/index.js",
        styles: ["dist/control-ui/theme.css"],
        httpRoutes: [
          {
            path: "/plugins/native-ui/notes",
            method: "POST",
            maxRequestBytes: 12582912,
            maxResponseBytes: 32768,
          },
        ],
      },
    });
  });

  it.each([
    { entry: "src/index.ts" },
    { entry: "dist/index.js" },
    { entry: "../dist/control-ui/index.js" },
    { entry: "/dist/control-ui/index.js" },
    { entry: "dist/control-ui/../server.js" },
    { entry: "dist\\control-ui\\index.js" },
    { entry: "dist/control-ui/index.js", styles: ["dist/server.css"] },
    { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/.secret.css"] },
    { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/code.js"] },
    { entry: "dist/control-ui/index.js", root: "/private" },
  ])("rejects unsafe or source declarations %j", (controlUi) => {
    expect(loadPluginManifest(fixture(controlUi).dir)).toMatchObject({
      ok: false,
      error: expect.stringContaining("controlUi"),
    });
  });
});
