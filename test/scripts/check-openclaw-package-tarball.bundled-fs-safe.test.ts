import { spawnSync } from "node:child_process";
import fs, { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "../../scripts/lib/workspace-bootstrap-smoke.mts";
import { packOpenClawPackageForDocker } from "../../scripts/package-openclaw-for-docker.mts";
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
    fixture(
      { dependencies: manifest.dependencies },
      undefined,
      "must be listed in bundleDependencies",
    );
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
  ])(
    "rejects changed runtime bytes: %s",
    (file) => {
      fixture(
        manifest,
        (root) => {
          const target = join(root, PREFIX, file);
          writeFileSync(target, readFileSync(target, "utf8") + "\n");
        },
        `unpatched or changed runtime entry ${file}`,
      );
    },
    60_000,
  );

  it("rejects missing publication implementation", () => {
    fixture(
      manifest,
      (root) => rmSync(join(root, PREFIX, "dist/publish-directory.js")),
      "missing required runtime entry dist/publish-directory.js",
    );
  }, 60_000);

  it("rejects changed native platform pins", () => {
    fixture(
      manifest,
      (root) => {
        const target = join(root, PREFIX, "package.json");
        const payload = JSON.parse(readFileSync(target, "utf8"));
        payload.optionalDependencies[`${NAME}-linux-x64-gnu`] = "0.18.1";
        writeFileSync(target, JSON.stringify(payload));
      },
      "must retain exact native dependency linux-x64-gnu",
    );
  }, 60_000);
});

// Reconstruct the installed graph with pnpm-style sibling dependency links.
// The older dereferenced fixture skips the npm producer boundary entirely.
function copyIsolatedFsSafeFixture(root: string) {
  const copied = new Map<string, string>();
  const copy = (source: string): string => {
    const real = fs.realpathSync(source);
    const previous = copied.get(real);
    if (previous) {
      return previous;
    }
    const packageJson = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
    const modules = join(root, "node_modules/.pnpm", `fixture-${copied.size}`, "node_modules");
    const destination = join(modules, packageJson.name);
    copied.set(real, destination);
    cpSync(real, destination, {
      recursive: true,
      dereference: true,
      filter: (sourcePath) => sourcePath !== join(real, "node_modules"),
    });
    const fromPackage = createRequire(join(real, "package.json"));
    for (const name of Object.keys({
      ...packageJson.dependencies,
      ...packageJson.optionalDependencies,
    })) {
      const sourceDependency = (fromPackage.resolve.paths(`${name}/package.json`) ?? [])
        .map((directory) => join(directory, name))
        .find((candidate) => fs.existsSync(join(candidate, "package.json")));
      if (!sourceDependency) {
        expect(
          Object.hasOwn(packageJson.optionalDependencies ?? {}, name),
          `required fixture dependency ${name} is missing from ${real}`,
        ).toBe(true);
        continue;
      }
      const target = copy(sourceDependency);
      const link = join(modules, name);
      fs.mkdirSync(dirname(link), { recursive: true });
      fs.symlinkSync(target, link, "junction");
    }
    return destination;
  };
  const source = copy(sourceRoot);
  fs.mkdirSync(join(root, "node_modules/@openclaw"), { recursive: true });
  const link = join(root, PREFIX);
  fs.symlinkSync(source, link, "junction");
  return { link, originalLink: fs.readlinkSync(link), source };
}

describe("canonical isolated fs-safe bundle transport", () => {
  it("packs the pnpm graph into a stable npm bundle and restores the source link", async () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "openclaw-fs-safe-pack-boundary-"));
    try {
      const source = join(root, "source");
      const output = join(root, "output");
      fs.mkdirSync(output);
      const files = {
        "dist/index.js": "export {};\n",
        "dist/agents/code-mode.worker.js": "export {};\n",
        "dist/control-ui/index.html": "<!doctype html><openclaw-app></openclaw-app>",
        "dist/control-ui/assets/app.js": "export {};\n",
        [PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH]: "export {};\n",
        ...Object.fromEntries(WORKSPACE_TEMPLATE_PACK_PATHS.map((file) => [file, `# ${file}\n`])),
      };
      for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(dirname(join(source, file)), { recursive: true });
        writeFileSync(join(source, file), content);
      }
      const packageJson = JSON.stringify({ name: "openclaw", version: "2026.9.7", ...manifest });
      writeFileSync(join(source, "package.json"), packageJson);
      const installed = copyIsolatedFsSafeFixture(source);
      // The inventory wrapper resolves its loader before invoking runImpl.
      fs.symlinkSync(
        dirname(require.resolve("tsx/package.json")),
        join(source, "node_modules/tsx"),
        "junction",
      );
      const originalAtomic = readFileSync(join(installed.source, "dist/atomic.js"));
      const fromInstalledFsSafe = createRequire(join(installed.source, "package.json"));
      const fromInstalledJsZip = createRequire(fromInstalledFsSafe.resolve("jszip/package.json"));
      const fromInstalledStream = createRequire(
        fromInstalledJsZip.resolve("readable-stream/package.json"),
      );
      const originalDecoderRoot = dirname(
        fromInstalledStream.resolve("string_decoder/package.json"),
      );
      const options = {
        prepareDocsMap: async () => {},
        restoreDocsMap: async () => {},
        prepareManifest: async () => {},
        restoreManifest: async () => {},
        prepareChangelog: async () => {},
        restoreChangelog: async () => {},
        runImpl: async () => {
          // Inventory production is not under test here; retain the checker's
          // real pack/extract/repack boundary and patched runtime validation.
          writeFileSync(
            join(source, "dist/postinstall-inventory.json"),
            JSON.stringify(Object.keys(files).filter((file) => file.startsWith("dist/"))),
          );
          writeFileSync(join(source, ".openclaw-lifecycle-pending"), "pending\n");
        },
      };
      const packed = await packOpenClawPackageForDocker(source, output, options);
      expectPackageCommandSuccess(check(packed), "check canonical pnpm fs-safe bundle");
      const extracted = join(root, "extracted");
      fs.mkdirSync(extracted);
      await tar.x({ file: packed, cwd: extracted });
      const bundled = join(extracted, "package", PREFIX);
      const bundledManifest = JSON.parse(readFileSync(join(bundled, "package.json"), "utf8"));
      const fromBundle = createRequire(join(bundled, "package.json"));
      // Resolving bare string_decoder would return Node's builtin and falsely
      // validate an absent declared package in this transitive dependency graph.
      const bundledDecoderRoot = join(
        bundled,
        "node_modules/jszip/node_modules/readable-stream/node_modules/string_decoder",
      );
      for (const file of ["package.json", "lib/string_decoder.js"]) {
        expect(readFileSync(join(bundledDecoderRoot, file))).toEqual(
          readFileSync(join(originalDecoderRoot, file)),
        );
      }
      for (const name of Object.keys(bundledManifest.dependencies ?? {})) {
        expect(fromBundle.resolve(name)).toContain(join(bundled, "node_modules"));
      }
      for (const name of Object.keys(bundledManifest.optionalDependencies ?? {})) {
        const originalModules = fromInstalledFsSafe.resolve.paths(`${name}/package.json`);
        const originallyInstalled = (originalModules ?? []).some((directory) =>
          fs.existsSync(join(directory, name, "package.json")),
        );
        if (originallyInstalled) {
          expect(fromBundle.resolve(`${name}/package.json`)).toContain(
            join(bundled, "node_modules"),
          );
        }
      }
      expect(readFileSync(join(bundled, "dist/atomic.js"))).toEqual(originalAtomic);
      expect(fs.existsSync(join(extracted, "package/node_modules/.pnpm"))).toBe(false);
      expect(fs.readlinkSync(installed.link)).toBe(installed.originalLink);
      expect(readFileSync(join(installed.source, "dist/atomic.js"))).toEqual(originalAtomic);
      expect(readFileSync(join(source, "package.json"), "utf8")).toBe(packageJson);
      await expect(
        packOpenClawPackageForDocker(source, output, {
          ...options,
          runCaptureImpl: async () => {
            throw new Error("pack failed after bundle staging");
          },
        }),
      ).rejects.toThrow("pack failed after bundle staging");
      expect(fs.readlinkSync(installed.link)).toBe(installed.originalLink);
      expect(readFileSync(join(installed.source, "dist/atomic.js"))).toEqual(originalAtomic);
      expect(fs.readdirSync(dirname(installed.link))).toEqual(["fs-safe"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
