import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { expectPackageCommandSuccess, withTarball } from "./package-tarball-fixture.js";

const require = createRequire(import.meta.url);
const NAME = "@openclaw/fs-safe";
const PREFIX = `node_modules/${NAME}`;
const sourceRoot = dirname(require.resolve(`${NAME}/package.json`));
const manifest = { dependencies: { [NAME]: "0.21.1" }, bundleDependencies: [NAME] };
const check = (tarball: string) =>
  spawnSync(process.execPath, [resolve("scripts/check-openclaw-package-tarball.mts"), tarball], {
    encoding: "utf8",
  });

function fixture(
  packageJson: Record<string, unknown>,
  mutate?: (root: string) => void,
  error?: string,
) {
  withTarball(
    ["dist/index.js"],
    { "dist/index.js": "export {};\n" },
    (tarball) => {
      const result = check(tarball);
      if (error) {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(error);
      } else {
        expectPackageCommandSuccess(result, "check bundled patched fs-safe");
      }
    },
    undefined,
    {
      packageJson,
      beforePack(root) {
        cpSync(sourceRoot, join(root, PREFIX), { recursive: true, dereference: true });
        mutate?.(root);
      },
    },
  );
}

describe("bundled patched fs-safe package", () => {
  it("accepts the real frozen patched dependency", () => fixture(manifest), 60_000);

  it("rejects an unbundled dependency", () => {
    fixture({ dependencies: manifest.dependencies }, undefined, "must be listed in bundleDependencies");
  }, 60_000);

  it("rejects a missing bundle", () => {
    fixture(
      manifest,
      (root) => rmSync(join(root, PREFIX), { recursive: true }),
      `must be bundled in ${PREFIX}`,
    );
  }, 60_000);

  it.each([
    "dist/atomic.js",
    "dist/publish-directory.js",
    "dist/mutation-authority.js",
    "dist/native-staged-file.js",
    "dist/sibling-staged-file.js",
    "dist/staged-file-settlement.js",
    "dist/pinned-write-input.js",
  ])("rejects changed runtime bytes: %s", (file) => {
    fixture(manifest, (root) => {
      const target = join(root, PREFIX, file);
      writeFileSync(target, readFileSync(target, "utf8") + "\n");
    }, `unpatched or changed runtime entry ${file}`);
  }, 60_000);

  it("rejects missing publication implementation", () => {
    fixture(
      manifest,
      (root) => rmSync(join(root, PREFIX, "dist/publish-directory.js")),
      "missing required runtime entry dist/publish-directory.js",
    );
  }, 60_000);

  it("rejects changed native platform pins", () => {
    fixture(manifest, (root) => {
      const target = join(root, PREFIX, "package.json");
      const payload = JSON.parse(readFileSync(target, "utf8"));
      payload.optionalDependencies[`${NAME}-linux-x64-gnu`] = "0.18.1";
      writeFileSync(target, JSON.stringify(payload));
    }, "must retain exact native dependency linux-x64-gnu");
  }, 60_000);
});
