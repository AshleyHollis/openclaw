import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  recordUpdateCompatibilityRelease,
  writeUpdateCompatibilityChunks,
} from "../../scripts/lib/update-compat-chunks.mts";
import { createScriptTestHarness } from "./test-helpers.js";
import {
  previousReleaseInventory,
  writeUpdateCompatibilityBuildFixture,
} from "./update-compat-chunks.test-support.js";

const { createTempDir } = createScriptTestHarness();
const chunk = previousReleaseInventory.releases[0]!.chunks.find((entry) =>
  /-[A-Za-z0-9_-]{8}\.m?js$/.test(entry.path),
)!;
const namedExport = {
  kind: "named export",
  source: 'export { helper as NAME } from "external-package";',
};
const namespaceImport = {
  kind: "namespace import",
  source: 'import * as NAME from "external-package"; export { NAME };',
};

it.each(["present", "missing", "external", "wrong symbol", "unmapped historical symbol"] as const)(
  "bridges shipped lease-worker paths only to the admitted current operation (%s)",
  async (target) => {
    const root = createTempDir("update-compat-lease-worker-move-");
    const oldModule = "src/state/openclaw-state-lease-worker-storage.ts";
    const currentModule = "src/state/openclaw-state-lease-worker-operation.ts";
    const symbol = "runWithOpenClawStateLeaseWorker";
    const inventory = {
      schemaVersion: 1 as const,
      releases: previousReleaseInventory.releases
        .map((release) => ({
          ...release,
          chunks: release.chunks
            .filter((entry) => entry.exports.some((binding) => binding.origin.module === oldModule))
            .map((entry) => ({
              ...entry,
              exports: entry.exports.map((binding) => ({
                ...binding,
                origin: {
                  ...binding.origin,
                  symbol:
                    target === "unmapped historical symbol"
                      ? "otherOperation"
                      : binding.origin.symbol,
                },
              })),
            })),
        }))
        .filter((release) => release.chunks.length > 0),
    };
    expect(inventory.releases.length).toBeGreaterThan(0);
    const historicalInventory = JSON.stringify(inventory);
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.mkdirSync(path.join(root, "src/state"), { recursive: true });
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, oldModule), 'export const storageOwner = "storage";\n');
    if (target !== "missing") {
      fs.writeFileSync(
        path.join(root, currentModule),
        target === "external"
          ? `export { ${symbol} } from "external-package";\n`
          : `export function ${target === "wrong symbol" ? "otherOperation" : symbol}() {}\n`,
      );
    }
    fs.writeFileSync(
      path.join(root, "dist/current.mjs"),
      `//#region ${currentModule}\nfunction ${symbol}() { return "admitted current operation"; } export { ${symbol} as n };\n`,
    );
    const options = { distDir: path.join(root, "dist"), sourceDir: root, inventory };
    if (target !== "present") {
      expect(() => writeUpdateCompatibilityChunks(options)).toThrow(
        target === "unmapped historical symbol"
          ? "no equivalent current export"
          : `Cannot resolve current source binding ${currentModule}:${symbol}`,
      );
      expect(fs.existsSync(path.join(root, "dist/update-compat-inventory.json"))).toBe(false);
      for (const release of inventory.releases) {
        for (const entry of release.chunks) {
          expect(fs.existsSync(path.join(root, "dist", entry.path))).toBe(false);
        }
      }
    } else {
      writeUpdateCompatibilityChunks(options);
      const current = await import(pathToFileURL(path.join(root, "dist/current.mjs")).href);
      for (const release of inventory.releases) {
        for (const entry of release.chunks) {
          const bridge = await import(pathToFileURL(path.join(root, "dist", entry.path)).href);
          expect(bridge[symbol]).toBe(current.n);
          expect(bridge[symbol]()).toBe("admitted current operation");
        }
      }
    }
    expect(JSON.stringify(inventory)).toBe(historicalInventory);
  },
);

it.each([
  'import { safePath as helper } from "@openclaw/fs-safe/path"; export { helper };',
  'import helper from "external-package"; export { helper };',
  'export { safePath as helper } from "@openclaw/fs-safe/path";',
  'export * as helper from "external-package";',
  'import * as helper from "external-package"; export { helper };',
])("keeps published updater bridges usable beside %s", async (external) => {
  const root = createTempDir("update-compat-external-");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  writeUpdateCompatibilityBuildFixture(root);
  fs.writeFileSync(
    path.join(root, "dist/unrelated-worker.mjs"),
    `//#region ${chunk.exports[0]!.origin.module}\n${external}\n`,
  );
  writeUpdateCompatibilityChunks({
    distDir: path.join(root, "dist"),
    sourceDir: root,
    inventory: previousReleaseInventory,
  });
  const legacy = await import(pathToFileURL(path.join(root, "dist", chunk.path)).href);
  for (const { exported, origin } of chunk.exports) {
    expect(legacy[exported]()).toBe(origin.symbol);
  }
});

it.each([namedExport, namespaceImport])(
  "refuses a required updater implementation replaced with an external $kind",
  ({ source: template }) => {
    const root = createTempDir("update-compat-required-external-");
    writeUpdateCompatibilityBuildFixture(root);
    const origin = chunk.exports[0]!.origin;
    const source = path.join(root, origin.module);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, `${template.replaceAll("NAME", origin.symbol)}\n`);
    expect(() =>
      writeUpdateCompatibilityChunks({
        distDir: path.join(root, "dist"),
        sourceDir: root,
        inventory: previousReleaseInventory,
      }),
    ).toThrow("Cannot resolve current source binding");
    expect(fs.existsSync(path.join(root, "dist/update-compat-inventory.json"))).toBe(false);
  },
);

it.each([
  namedExport,
  { kind: "namespace export", source: 'export * as NAME from "external-package";' },
])("refuses to omit a published external $kind", ({ source }) => {
  const root = createTempDir("update-compat-published-external-");
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.1" }),
  );
  fs.writeFileSync(
    path.join(root, "dist/build-info.json"),
    JSON.stringify({ version: "2026.9.1", buildId: "fixture", commit: "0".repeat(40) }),
  );
  fs.writeFileSync(
    path.join(root, "dist/command.mjs"),
    '//#region src/cli/update-cli/update-command-service-command.ts\nexport async function restart() { return await import("./surface-abcdefgh.mjs"); }\n',
  );
  fs.writeFileSync(
    path.join(root, "dist/surface-abcdefgh.mjs"),
    `//#region src/infra/value.ts\nexport const owned = 1;\n${source.replaceAll("NAME", "external")}\n`,
  );
  expect(() =>
    recordUpdateCompatibilityRelease({
      packageDir: root,
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    }),
  ).toThrow("Cannot trace surface-abcdefgh.mjs export external to its release source");
});

it.each(["present", "missing"] as const)(
  "excludes standalone worker instances when the primary updater implementation is %s",
  async (runtime) => {
    const root = createTempDir("update-compat-standalone-worker-");
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    writeUpdateCompatibilityBuildFixture(root);
    const origin = chunk.exports[0]!.origin;
    const dist = path.join(root, "dist");
    const primary = fs
      .readdirSync(dist)
      .find(
        (name) =>
          name.startsWith("candidate-") &&
          fs.readFileSync(path.join(dist, name), "utf8").includes(`function ${origin.symbol}()`),
      );
    expect(primary).toBeDefined();
    const primaryPath = path.join(dist, primary!);
    fs.mkdirSync(path.join(dist, "state"), { recursive: true });
    fs.copyFileSync(primaryPath, path.join(dist, "state/openclaw-state-read.worker.js"));
    const options = { distDir: dist, sourceDir: root, inventory: previousReleaseInventory };
    if (runtime === "missing") {
      fs.unlinkSync(primaryPath);
      expect(() => writeUpdateCompatibilityChunks(options)).toThrow(/no equivalent current export/);
      expect(fs.existsSync(path.join(dist, chunk.path))).toBe(false);
      return;
    }
    writeUpdateCompatibilityChunks(options);
    const bridge = await import(pathToFileURL(path.join(dist, chunk.path)).href);
    const declaration = await import(pathToFileURL(primaryPath).href);
    expect(Object.values(declaration)).toContain(bridge[chunk.exports[0]!.exported]);
    expect(bridge[chunk.exports[0]!.exported]()).toBe(origin.symbol);
  },
);
