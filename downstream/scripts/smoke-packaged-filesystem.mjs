import assert from "node:assert/strict";
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

  assert.equal(getFsSafeNativeConfig().mode, "auto");
  console.log(
    "PASS packaged SDK: native durable staging, no-overwrite, unchanged global policy",
  );
} finally {
  for (const stage of stages) await stage.cleanup();
  await rm(directory, { recursive: true, force: true });
}
