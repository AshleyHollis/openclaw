import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateCurrentHostRecords } from "./validate-current-host-image-inputs.mjs";

const read = async (name) => JSON.parse(await readFile(new URL(`../runtime-install/current-host/${name}`, import.meta.url), "utf8"));
const candidate = JSON.parse(await readFile(new URL("../runtime-install/candidate.json", import.meta.url), "utf8"));
const host = await read("host.package-lock.json");
const plugins = await read("plugins.package-lock.json");
const actual = {
  build: { version: candidate.hostVersion, commit: candidate.hostProducedFrom },
  hostSha256: candidate.hostArchiveSha256, hostIntegrity: host.packages["node_modules/openclaw"].integrity,
  codexSha256: candidate.components.codex.sha256, codexIntegrity: plugins.packages["node_modules/@openclaw/codex"].integrity,
  qmdSha256: candidate.components.qmd.sha256, ccSha256: candidate.commandCenter.archiveSha256,
};
for (const failure of [null, "public-version-only", "old-lock", "archive", "codex-integrity", "discord", "peer", "cc", "qmd"]) {
  test(`current-host artifact admission: ${failure ?? "matching"}`, () => {
    const a = structuredClone(actual), h = structuredClone(host), p = structuredClone(plugins);
    if (failure === "public-version-only") a.build.commit = "f".repeat(40);
    if (failure === "old-lock") h.packages["node_modules/openclaw"].version = "2026.9.6";
    if (failure === "archive") a.hostIntegrity = "different";
    if (failure === "codex-integrity") a.codexIntegrity = "different";
    if (failure === "discord") p.packages["node_modules/@openclaw/discord"] = {};
    if (failure === "peer") p.packages["node_modules/openclaw"].resolved = "/registry-host";
    if (failure === "cc") a.ccSha256 = "0".repeat(64);
    if (failure === "qmd") a.qmdSha256 = "0".repeat(64);
    if (failure) assert.throws(() => validateCurrentHostRecords(candidate, h, p, a));
    else assert.equal(validateCurrentHostRecords(candidate, h, p, a), candidate);
  });
}
test("Life recipe uses current locks, exact producer, Codex and QMD; no Discord", async () => {
  const recipe = await readFile(new URL("../Dockerfile.packaged-runtime", import.meta.url), "utf8");
  assert(!/discord/iu.test(recipe));
  assert(recipe.includes("${RUNTIME_INPUT_ROOT}/host.package-lock.json"));
  assert(recipe.includes("${RUNTIME_INPUT_ROOT}/plugins.package-lock.json"));
  assert(recipe.includes(candidate.hostProducedFrom));
  assert(recipe.includes(candidate.hostArchiveSha256));
  assert(recipe.includes(candidate.components.codex.sha256));
  assert(recipe.includes(candidate.components.qmd.sha256));
  assert(recipe.includes('ARG CODEX_ENGINE_VERSION="0.158.0"'));
  assert(recipe.includes('codex-cli $CODEX_ENGINE_VERSION'));
  assert(recipe.includes("dist/build-info.json"));
});
