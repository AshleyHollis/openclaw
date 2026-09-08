import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateInstalledPluginRuntime } from "./validate-installed-plugin-runtime.mjs";

for (const failure of [null, "missing-plugin", "version", "declaration", "integrity", "peer"]) {
  test(`managed installation lock admission: ${failure ?? "matching"}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plugin-installation-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dependencies = {
      "@openclaw/codex": "file:/tmp/codex.tgz",
      "@openclaw/discord": "file:/tmp/discord.tgz",
    };
    const manifest = { name: "openclaw-nas-plugin-runtime", dependencies };
    const lock = {
      name: manifest.name,
      lockfileVersion: 3,
      packages: { "": { dependencies: { ...dependencies } } },
    };
    for (const id of ["codex", "discord"]) {
      const location = `node_modules/@openclaw/${id}`;
      await mkdir(path.join(root, location, "node_modules"), { recursive: true });
      await writeFile(
        path.join(root, location, "package.json"),
        JSON.stringify({ name: `@openclaw/${id}`, version: "2026.9.2" }),
      );
      lock.packages[location] = {
        version: "2026.9.2",
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      };
      await symlink(
        failure === "peer" ? "/other-host" : "/fictional-host",
        path.join(root, location, "node_modules/openclaw"),
      );
    }
    await symlink("/fictional-host", path.join(root, "node_modules/openclaw"));
    if (failure === "missing-plugin")
      await rm(path.join(root, "node_modules/@openclaw/discord/package.json"));
    if (failure === "version") lock.packages["node_modules/@openclaw/codex"].version = "old";
    if (failure === "integrity") delete lock.packages["node_modules/@openclaw/discord"].integrity;
    if (failure === "declaration") lock.packages[""].dependencies["@openclaw/codex"] = "other";
    await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
    if (failure) await assert.rejects(validateInstalledPluginRuntime(root, "/fictional-host"));
    else assert.deepEqual(await validateInstalledPluginRuntime(root, "/fictional-host"), manifest);
  });
}
