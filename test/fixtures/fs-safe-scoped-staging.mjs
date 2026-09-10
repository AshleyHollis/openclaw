// Real-library diagnostic. Optional package directory selects pnpm's editable patch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = process.argv[2];
const load = (entry) =>
  import(
    packageRoot
      ? pathToFileURL(path.join(packageRoot, "dist", `${entry}.js`)).href
      : pathToFileURL(require.resolve(`@openclaw/fs-safe/${entry}`)).href
  );
const { stageFileInDirectory } = await load("advanced");
const { configureFsSafeNative, getFsSafeNativeConfig } = await load("config");
configureFsSafeNative({ mode: "off" });
const content = '{"version":1,"id":"8f976bb9-06dc-44cd-884d-9d820ac54fe4"}\n';
const scoped = { nativeMode: "require", durability: "strict" };

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-staging-proof-"));
  try {
    await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("explicit staging preserves the off default and publishes complete bytes", async () => {
  await fixture(async (directory) => {
    await assert.rejects(stageFileInDirectory({ directory, content }), {
      code: "helper-unavailable",
    });
    const before = getFsSafeNativeConfig();
    const staged = await stageFileInDirectory({ directory, content, ...scoped });
    try {
      assert.deepEqual(getFsSafeNativeConfig(), before);
      assert.equal(fs.existsSync(path.join(directory, "marker")), false);
      const published = await staged.publish("marker", { overwrite: false });
      assert.equal(published.status, "published");
      assert.equal(fs.readFileSync(path.join(directory, "marker"), "utf8"), content);
      assert.equal(fs.statSync(path.join(directory, "marker")).nlink, 1);
    } finally {
      await staged.cleanup();
    }
    assert.deepEqual(getFsSafeNativeConfig(), before);
    await assert.rejects(stageFileInDirectory({ directory, content }), {
      code: "helper-unavailable",
    });
    assert.deepEqual(fs.readdirSync(directory), ["marker"]);
  });
});

test("no-replace staging preserves an existing foreign marker", async () => {
  await fixture(async (directory) => {
    fs.writeFileSync(path.join(directory, "marker"), "foreign");
    const staged = await stageFileInDirectory({ directory, content, ...scoped });
    try {
      await assert.rejects(staged.publish("marker", { overwrite: false }), (error) => {
        assert.equal(error.code, "already-exists");
        assert.equal(error.details.publication.status, "not-published");
        return true;
      });
    } finally {
      await staged.cleanup();
    }
    assert.equal(fs.readFileSync(path.join(directory, "marker"), "utf8"), "foreign");
    assert.deepEqual(fs.readdirSync(directory), ["marker"]);
  });
});

test("directory rebinding refuses publication and cleans only the owned stage", async () => {
  await fixture(async (root) => {
    const directory = path.join(root, "bound");
    fs.mkdirSync(directory);
    const staged = await stageFileInDirectory({ directory, content, ...scoped });
    try {
      fs.renameSync(directory, path.join(root, "original"));
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "marker"), "replacement");
      await assert.rejects(staged.publish("marker", { overwrite: false }), {
        code: "path-mismatch",
      });
    } finally {
      await staged.cleanup();
    }
    assert.deepEqual(fs.readdirSync(path.join(root, "original")), []);
    assert.equal(fs.readFileSync(path.join(directory, "marker"), "utf8"), "replacement");
  });
});

test("strict preparation sync failure creates no published name", async () => {
  await fixture(async (directory) => {
    const original = fs.fsyncSync;
    fs.fsyncSync = () => {
      throw Object.assign(new Error("injected sync denial"), { code: "EPERM" });
    };
    try {
      await assert.rejects(stageFileInDirectory({ directory, content, ...scoped }), {
        code: "EPERM",
      });
    } finally {
      fs.fsyncSync = original;
    }
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});

for (const syncTarget of ["file", "directory"])
  test(`strict post-publication ${syncTarget} sync failure retains a truthful published outcome`, async () => {
    await fixture(async (directory) => {
      const staged = await stageFileInDirectory({ directory, content, ...scoped });
      const original = fs.fsyncSync;
      fs.fsyncSync = (fd) => {
        if (fs.fstatSync(fd).isDirectory() === (syncTarget === "directory"))
          throw Object.assign(new Error("injected sync denial"), { code: "EPERM" });
        return original(fd);
      };
      try {
        await assert.rejects(staged.publish("marker", { overwrite: false }), (error) => {
          assert.equal(error.details.phase, "publish");
          assert.equal(error.details.publication.status, "published");
          return true;
        });
      } finally {
        fs.fsyncSync = original;
        await staged.cleanup();
      }
      assert.equal(fs.readFileSync(path.join(directory, "marker"), "utf8"), content);
    });
  });

test("missing platform binding fails before creating a marker", async () => {
  await fixture(async (root) => {
    const originalPackage =
      packageRoot ?? path.dirname(path.dirname(require.resolve("@openclaw/fs-safe/advanced")));
    const isolated = path.join(root, "package");
    fs.mkdirSync(isolated);
    fs.cpSync(path.join(originalPackage, "dist"), path.join(isolated, "dist"), { recursive: true });
    fs.copyFileSync(
      path.join(originalPackage, "package.json"),
      path.join(isolated, "package.json"),
    );
    const directory = path.join(root, "folder");
    fs.mkdirSync(directory);
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { pathToFileURL } from "node:url";
      const [pkg, directory] = process.argv.slice(1);
      const { stageFileInDirectory } = await import(pathToFileURL(pkg + "/dist/advanced.js"));
      const { configureFsSafeNative } = await import(pathToFileURL(pkg + "/dist/config.js"));
      configureFsSafeNative({ mode: "off" });
      await assert.rejects(stageFileInDirectory({ directory, content: "marker", nativeMode: "require", durability: "strict" }), { code: "helper-unavailable" });
      assert.deepEqual(fs.readdirSync(directory), []);
    `,
        isolated,
        directory,
      ],
      {
        timeout: 10_000,
        windowsHide: true,
        env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
        stdio: "pipe",
      },
    );
  });
});

test("existing best-effort callers retain EPERM handling", async () => {
  await fixture(async (directory) => {
    const original = fs.fsyncSync;
    configureFsSafeNative({ mode: "require" });
    fs.fsyncSync = () => {
      throw Object.assign(new Error("injected sync denial"), { code: "EPERM" });
    };
    let staged;
    try {
      staged = await stageFileInDirectory({ directory, content });
      assert.equal((await staged.publish("marker", { overwrite: false })).status, "published");
    } finally {
      fs.fsyncSync = original;
      configureFsSafeNative({ mode: "off" });
      await staged?.cleanup();
    }
    assert.equal(fs.readFileSync(path.join(directory, "marker"), "utf8"), content);
  });
});

test("unsupported per-operation settings fail before creating files", async () => {
  await fixture(async (directory) => {
    for (const options of [{ nativeMode: "auto" }, { ...scoped, durability: "ignore" }]) {
      await assert.rejects(stageFileInDirectory({ directory, content, ...options }), {
        code: "invalid-path",
      });
    }
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});
