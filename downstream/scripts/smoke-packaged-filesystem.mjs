import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Exercise installed SDK bytes, not a source checkout with pnpm's patched deps.
const require = createRequire("/app/package.json");
const { stageDurableFileInDirectory } = await import(
  pathToFileURL(require.resolve("openclaw/plugin-sdk/file-access-runtime")).href
);
const { getFsSafeNativeConfig } = await import(
  pathToFileURL(require.resolve("@openclaw/fs-safe/config")).href
);
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "packaged-fs-smoke-")));
const stages = [];
const originalSync = fs.fsyncSync;
try {
  // OpenClaw 2026.9.5 preserves fs-safe 0.13.1's native auto mode.
  assert.equal(getFsSafeNativeConfig().mode, "auto");
  const stage = await stageDurableFileInDirectory({ directory, content: "original", mode: 0o600 });
  stages.push(stage);
  assert.equal((await stage.publish("identity", { overwrite: false })).status, "published");
  assert.equal(await readFile(path.join(directory, "identity"), "utf8"), "original");
  const duplicate = await stageDurableFileInDirectory({ directory, content: "replacement" });
  stages.push(duplicate);
  await assert.rejects(duplicate.publish("identity", { overwrite: false }));
  assert.equal(await readFile(path.join(directory, "identity"), "utf8"), "original");

  // Unexpected sync failures must still reject staging and publication. fs-safe
  // intentionally treats EPERM as best effort, so use a hard I/O failure here.
  const failure = Object.assign(new Error("synthetic sync failure"), { code: "EIO" });
  const isSyncFailure = (error) => {
    for (let cause = error; cause; cause = cause.cause) {
      if (cause === failure) return true;
    }
    return false;
  };
  fs.fsyncSync = () => {
    throw failure;
  };
  await assert.rejects(
    stageDurableFileInDirectory({ directory, content: "must-not-succeed" }),
    isSyncFailure,
  );
  fs.fsyncSync = originalSync;
  // Publication syncs both the file and its directory; neither may be swallowed.
  for (const failAt of [1, 2]) {
    const publishing = await stageDurableFileInDirectory({ directory, content: "publication" });
    stages.push(publishing);
    let syncs = 0;
    fs.fsyncSync = (fd) => {
      if (++syncs === failAt) throw failure;
      return originalSync(fd);
    };
    await assert.rejects(publishing.publish(`sync-${failAt}`, { overwrite: false }), isSyncFailure);
    fs.fsyncSync = originalSync;
  }
  assert.equal(getFsSafeNativeConfig().mode, "auto");
  console.log(
    "PASS packaged SDK: durable staging, no-overwrite, strict sync failure, unchanged global policy",
  );
} finally {
  fs.fsyncSync = originalSync;
  for (const stage of stages) await stage.cleanup();
  await rm(directory, { recursive: true, force: true });
}
