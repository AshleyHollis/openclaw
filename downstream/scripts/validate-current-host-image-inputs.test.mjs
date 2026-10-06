import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateCurrentHostRecords, validateQmdRuntimeRecords } from "./validate-current-host-image-inputs.mjs";

const read = async (name) => JSON.parse(await readFile(new URL(`../runtime-install/current-host/${name}`, import.meta.url), "utf8"));
const candidate = JSON.parse(await readFile(new URL("../runtime-install/candidate.json", import.meta.url), "utf8"));
const host = await read("host.package-lock.json");
const plugins = await read("plugins.package-lock.json");
const qmdLock = await read("qmd.package-lock.json");
const qmdManifest = await read("qmd.package.json");
const actual = {
  build: { version: candidate.hostVersion, commit: candidate.hostProducedFrom },
  hostSha256: candidate.hostArchiveSha256, hostArchiveBytes: candidate.hostArchiveBytes,
  hostIntegrity: host.packages["node_modules/openclaw"].integrity,
  codexSha256: candidate.components.codex.sha256, codexIntegrity: plugins.packages["node_modules/@openclaw/codex"].integrity,
  qmdSha256: candidate.components.qmd.sha256, ccSha256: candidate.commandCenter.archiveSha256,
};
for (const failure of [
  null,
  "public-version-only",
  "forged-producer",
  "source-head",
  "old-lock",
  "archive",
  "host-lock",
  "host-archive",
  "host-archive-bytes",
  "codex-integrity",
  "discord",
  "peer",
  "cc",
  "qmd",
]) {
  test(`current-host-records: ${failure ?? "matching"}`, () => {
    const c = structuredClone(candidate), a = structuredClone(actual), h = structuredClone(host), p = structuredClone(plugins);
    if (failure === "public-version-only") a.build.commit = "f".repeat(40);
    if (failure === "forged-producer") {
      c.hostProducedFrom = "f".repeat(40);
      a.build.commit = c.hostProducedFrom;
    }
    if (failure === "source-head") c.sourceHead = "f".repeat(40);
    if (failure === "old-lock") h.packages["node_modules/openclaw"].version = "2026.9.6";
    if (failure === "archive") a.hostIntegrity = "different";
    if (failure === "host-lock") h.packages["node_modules/openclaw"].integrity = "different";
    if (failure === "host-archive") a.hostSha256 = "0".repeat(64);
    if (failure === "host-archive-bytes") a.hostArchiveBytes -= 1;
    if (failure === "codex-integrity") a.codexIntegrity = "different";
    if (failure === "discord") p.packages["node_modules/@openclaw/discord"] = {};
    if (failure === "peer") p.packages["node_modules/openclaw"].resolved = "/registry-host";
    if (failure === "cc") a.ccSha256 = "0".repeat(64);
    if (failure === "qmd") a.qmdSha256 = "0".repeat(64);
    if (failure) assert.throws(() => validateCurrentHostRecords(c, h, p, a));
    else assert.equal(validateCurrentHostRecords(c, h, p, a), c);
  });
}
test("Life recipe uses current locks, exact producer, Codex and QMD; no Discord", async () => {
  const recipe = await readFile(new URL("../Dockerfile.packaged-runtime", import.meta.url), "utf8");
  assert(!/discord/iu.test(recipe));
  assert(recipe.includes("runtime-install/current-host/host.package-lock.json"));
  assert(recipe.includes("runtime-install/current-host/plugins.package-lock.json"));
  assert(recipe.includes("runtime-install/current-host/qmd.package-lock.json"));
  assert(recipe.includes("npm ci --prefix /opt/qmd-runtime"));
  assert(recipe.includes(candidate.hostProducedFrom));
  assert(recipe.includes(candidate.hostArchiveSha256));
  assert(recipe.includes(candidate.components.codex.sha256));
  assert(recipe.includes(candidate.components.qmd.sha256));
  assert(recipe.includes("codex-cli 0.158.0"));
  assert(recipe.includes("dist/build-info.json"));
});

for (const failure of [null, "archive", "missing-root", "vulnerable-copy"]) {
  test(`QMD root installation admission: ${failure ?? "matching"}`, () => {
    const lock = structuredClone(qmdLock);
    let archiveIntegrity = lock.packages["node_modules/@tobilu/qmd"].integrity;
    if (failure === "archive") archiveIntegrity = "sha512-wrong";
    if (failure === "missing-root") delete lock.packages[""].dependencies;
    if (failure === "vulnerable-copy") lock.packages["node_modules/@tobilu/qmd/node_modules/simple-git"] = { version: "3.36.0" };
    const run = () => validateQmdRuntimeRecords(candidate, qmdManifest, lock, archiveIntegrity);
    if (failure) assert.throws(run); else run();
  });
}
