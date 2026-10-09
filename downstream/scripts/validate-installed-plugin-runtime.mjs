import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateCodeSelection } from "./validate-packaged-candidate.mjs";
import { readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function validateInstalledPluginRuntime(
  root,
  hostRoot = "/app/node_modules/openclaw",
  candidate = null,
) {
  const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
  const manifest = await readJson("package.json");
  const lock = await readJson("package-lock.json");
  if (
    manifest.name !== "openclaw-nas-plugin-runtime" ||
    lock.name !== manifest.name ||
    lock.lockfileVersion !== 3
  )
    throw new Error("image plugin installation identity mismatch");
  const declared = manifest.dependencies;
  const locked = lock.packages?.[""]?.dependencies;
  if (
    !declared ||
    !locked ||
    Object.keys(declared).length !== Object.keys(locked).length ||
    Object.entries(declared).some(([name, value]) => locked[name] !== value)
  )
    throw new Error("image plugin installation declarations differ from lock");
  if (!declared["@openclaw/codex"]) throw new Error("image Codex runtime missing");
  for (const id of ["codex", "discord"].filter((id) => declared[`@openclaw/${id}`])) {
    const name = `@openclaw/${id}`;
    const installed = await readJson(`node_modules/${name}/package.json`);
    const entry = lock.packages?.[`node_modules/${name}`];
    if (
      !declared[name] ||
      installed.name !== name ||
      !installed.version ||
      installed.version !== entry?.version ||
      !/^sha512-[A-Za-z0-9+/]+=*$/u.test(entry.integrity ?? "")
    )
      throw new Error("image plugin package differs from installation lock");
    if (
      (await readlink(path.join(root, `node_modules/${name}/node_modules/openclaw`))) !== hostRoot
    )
      throw new Error("image plugin host peer differs");
  }
  if ((await readlink(path.join(root, "node_modules/openclaw"))) !== hostRoot)
    throw new Error("image root host peer differs");
  if (candidate) {
    validateCodeSelection(candidate);
    for (const [name, digest] of Object.entries(candidate.locks)) {
      const file = name === "host.package-lock.json" ? path.join(hostRoot, "../../package-lock.json") : path.join(root, "package-lock.json");
      assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), digest, "installed lock bytes differ");
    }
    const engineRoot = "node_modules/@openclaw/codex/node_modules/@openai/codex";
    assert.equal((await readJson(`${engineRoot}/package.json`)).version, "0.160.0");
    assert.equal(lock.packages?.[engineRoot]?.version, "0.160.0");
    const platformRoot = `${engineRoot}/node_modules/@openai/codex-linux-x64`;
    const rawManifest = await readFile(path.join(root, platformRoot, "package.json"));
    assert.equal(createHash("sha256").update(rawManifest).digest("hex"), candidate.codexPlatform.manifestSha256);
    const platform = JSON.parse(rawManifest);
    assert.equal(platform.name, "@openai/codex");
    assert.equal(platform.version, candidate.codexPlatform.packageVersion);
    assert.deepEqual(platform.os, ["linux"]);
    assert.deepEqual(platform.cpu, ["x64"]);
    assert.equal(lock.packages?.[platformRoot]?.version, platform.version);
    assert.equal(createHash("sha256").update(await readFile(path.join(root, platformRoot, candidate.codexPlatform.binaryRelativePath))).digest("hex"), candidate.codexPlatform.binarySha256);
    const host = JSON.parse(await readFile(path.join(hostRoot, "dist/build-info.json"), "utf8"));
    assert.equal(host.commit, candidate.hostProducedFrom);
    assert.equal(host.version, candidate.hostVersion);
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const profile = process.argv[2] ?? "paired-life";
  assert(["paired-life", "code"].includes(profile), "unknown runtime profile");
  const selected = JSON.parse(await readFile("/opt/openclaw-runtime/candidate.json", "utf8"));
  if (profile === "paired-life") assert(selected.role === undefined || selected.role === "paired-life");
  await validateInstalledPluginRuntime("/opt/openclaw-plugin-runtime", undefined, profile === "code" ? selected : null);
}
