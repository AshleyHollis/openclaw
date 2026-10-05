import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export function validateCurrentHostRecords(candidate, hostLock, pluginLock, actual) {
  assert.equal(candidate.hostVersion, "2026.9.8");
  assert.equal(candidate.hostProducedFrom, "13c9575fa34c1d8166223473f7446b9c3889ac64");
  assert.equal(actual.build.version, candidate.hostVersion);
  assert.equal(actual.build.commit, candidate.hostProducedFrom);
  assert.equal(actual.hostSha256, candidate.hostArchiveSha256);
  assert.equal(hostLock.packages["node_modules/openclaw"].version, candidate.hostVersion);
  assert.equal(hostLock.packages["node_modules/openclaw"].resolved, "file:../tmp/openclaw-current.tgz");
  assert.equal(hostLock.packages["node_modules/openclaw"].integrity, actual.hostIntegrity);
  assert.deepEqual(Object.keys(pluginLock.packages[""].dependencies).sort(), ["@openclaw/codex", "openclaw"]);
  const codex = pluginLock.packages["node_modules/@openclaw/codex"];
  assert.equal(codex.version, candidate.components.codex.version);
  assert.equal(codex.integrity, actual.codexIntegrity);
  assert.equal(actual.codexSha256, candidate.components.codex.sha256);
  assert.equal(actual.qmdSha256, candidate.components.qmd.sha256);
  assert.equal(actual.ccSha256, candidate.commandCenter.archiveSha256);
  assert.equal(pluginLock.packages["node_modules/openclaw"].link, true);
  assert.equal(path.resolve("/opt/openclaw-plugin-runtime", pluginLock.packages["node_modules/openclaw"].resolved), "/app/node_modules/openclaw");
  assert(!Object.keys(pluginLock.packages).some((key) => key.includes("@openclaw/discord")));
  return candidate;
}

export async function validateCurrentHostImageInputs(root) {
  const overlay = new URL("../runtime-install/current-host/", import.meta.url);
  const readJson = async (name) => JSON.parse(await readFile(new URL(name, overlay), "utf8"));
  const candidate = JSON.parse(await readFile(new URL("../runtime-install/candidate.json", import.meta.url), "utf8"));
  const hostBytes = await readFile(path.join(root, "openclaw-current.tgz"));
  const codexBytes = await readFile(path.join(root, "codex-current.tgz"));
  const build = JSON.parse(execFileSync("tar", ["-xOf", path.join(root, "openclaw-current.tgz"), "package/dist/build-info.json"], { maxBuffer: 65536 }));
  const actual = {
    build, hostSha256: sha(hostBytes), hostIntegrity: integrity(hostBytes),
    codexSha256: sha(codexBytes), codexIntegrity: integrity(codexBytes),
    qmdSha256: sha(await readFile(path.join(root, "qmd-current.tgz"))),
    ccSha256: sha(await readFile(path.join(root, "command-center.tgz"))),
  };
  for (const [name, digest] of Object.entries(candidate.locks)) {
    assert.equal(sha(await readFile(new URL(name, overlay))), digest, `${name} bytes differ`);
  }
  return validateCurrentHostRecords(candidate, await readJson("host.package-lock.json"), await readJson("plugins.package-lock.json"), actual);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const candidate = await validateCurrentHostImageInputs(process.argv[2] ?? process.cwd());
  console.log(JSON.stringify({ inputsVerified: true, hostProducedFrom: candidate.hostProducedFrom, imageBuilt: false, installed: false }));
}
