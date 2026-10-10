import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateCurrentHostRecords } from "./validate-current-host-image-inputs.mjs";
import {
  PAIRED_LIFE_SELECTION,
  validatePairedLifeSelection,
  runtimeSelectionPaths,
} from "./validate-packaged-candidate.mjs";

const read = async (name) =>
  JSON.parse(
    await readFile(new URL(`../runtime-install/current-code/${name}`, import.meta.url), "utf8"),
  );
const candidate = JSON.parse(
  await readFile(
    new URL("../runtime-install/current-code/candidate.json", import.meta.url),
    "utf8",
  ),
);
candidate.role = "paired-life";
candidate.components.qmd = {
  version: "2.1.0",
  url: "https://github.com/AshleyHollis/openclaw/releases/download/nas-v2026.7.1-2.6/openclaw-qmd-2.1.0-nas.6.tgz",
  sha256: "4162fcc8812d44246065d121a339554419b55aeb4358fc61ca4acbda753bf28a",
};
candidate.commandCenter = {
  sourceCommit: PAIRED_LIFE_SELECTION.source,
  archiveSha256: PAIRED_LIFE_SELECTION.archive,
  buildDigest: PAIRED_LIFE_SELECTION.build,
  receiptSha256: PAIRED_LIFE_SELECTION.receipt,
  artifact: PAIRED_LIFE_SELECTION.artifact,
  carrierImage: PAIRED_LIFE_SELECTION.carrier,
};
const host = await read("host.package-lock.json");
const plugins = await read("plugins.package-lock.json");
const actual = {
  build: { version: candidate.hostVersion, commit: candidate.hostProducedFrom },
  hostSha256: candidate.hostArchiveSha256,
  hostIntegrity: host.packages["node_modules/openclaw"].integrity,
  codexSha256: candidate.components.codex.sha256,
  codexIntegrity: plugins.packages["node_modules/@openclaw/codex"].integrity,
  qmdSha256: candidate.components.qmd.sha256,
  ccSha256: candidate.commandCenter.archiveSha256,
};
for (const failure of [
  null,
  "public-version-only",
  "old-lock",
  "archive",
  "codex-integrity",
  "discord",
  "peer",
  "cc",
  "qmd",
]) {
  test(`current-host artifact admission: ${failure ?? "matching"}`, () => {
    const a = structuredClone(actual),
      h = structuredClone(host),
      p = structuredClone(plugins);
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
test("paired-Life selects its own input directory without changing Code", () => {
  assert.deepEqual(runtimeSelectionPaths(), {
    candidate: "downstream/runtime-install/current-life/candidate.json",
    inputRoot: "downstream/runtime-install/current-life",
    target: "runtime",
  });
  assert.equal(runtimeSelectionPaths("code").inputRoot, "downstream/runtime-install/current-code");
});

for (const [name, mutate] of Object.entries({
  role: (c) => (c.role = "unknown"),
  version: (c) => (c.hostVersion = "2026.9.8"),
  source: (c) => (c.hostProducedFrom = "0".repeat(40)),
  ccSource: (c) => (c.commandCenter.sourceCommit = "0".repeat(40)),
  ccArchive: (c) => (c.commandCenter.archiveSha256 = "0".repeat(64)),
  ccReceipt: (c) => (c.commandCenter.receiptSha256 = "0".repeat(64)),
  ccBuild: (c) => (c.commandCenter.buildDigest = "0".repeat(64)),
  ccArtifact: (c) => (c.commandCenter.artifact = {}),
  ccCarrier: (c) => (c.commandCenter.carrierImage = "unbound"),
  extraComponent: (c) => (c.components.discord = {}),
  qmd: (c) => (c.components.qmd.sha256 = "0".repeat(64)),
  registry: (c) => c.companionArtifact.id++,
  platformBinary: (c) => (c.codexPlatform.binarySha256 = "0".repeat(64)),
  lock: (c) => (c.locks["plugins.package-lock.json"] = "0".repeat(64)),
}))
  test(`paired-Life rejects mixed or unsealed ${name}`, () => {
    const c = structuredClone(candidate);
    mutate(c);
    assert.throws(() => validatePairedLifeSelection(c));
  });
