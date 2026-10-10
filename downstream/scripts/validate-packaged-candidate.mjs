import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Product and tooling are separate: the Code profile consumes the frozen EA
// package, never a package rebuilt from this recipe-only successor.
export const CODE_SELECTION = Object.freeze({
  source: "ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2",
  archive: "acf8cd1cedd1b64f6b855c7177fd3340a03208cd9cbf30aeaf5a511d2e2ef470",
  companion: "4dbfc268212996f43ce5ea6a42b281bf5358c065618185de3e4cc3f31d8dbf13",
  registryManifest: "1e52816586e4cf01d1d469228027b28e769e6eb6e53518a1e8ffc17b64bdbbee",
});

export function runtimeSelectionPaths(profile = "paired-life") {
  assert(["paired-life", "code"].includes(profile), "unknown runtime profile");
  return profile === "code"
    ? {
        candidate: "downstream/runtime-install/current-code/candidate.json",
        inputRoot: "downstream/runtime-install/current-code",
        target: "code-runtime",
      }
    : {
        candidate: "downstream/runtime-install/current-life/candidate.json",
        inputRoot: "downstream/runtime-install/current-life",
        target: "runtime",
      };
}

function validateNativeSelection(candidate) {
  assert.equal(candidate.platform, "linux/amd64");
  assert.equal(candidate.hostVersion, "2026.9.9");
  assert.equal(candidate.hostProducedFrom, CODE_SELECTION.source);
  assert.equal(candidate.hostArchiveSha256, CODE_SELECTION.archive);
  assert.equal(candidate.hostRunId, 37873292633);
  assert.equal(candidate.hostRunCommit, "6527403cfe201d0508450ad39c0a985599f2c8b3");
  assert.equal(candidate.hostArtifactId, 11591748081);
  assert.equal(
    candidate.hostArtifactDigest,
    "sha256:ee26e271682091ca442d6caa2211adb89a03aeed3f9f34bb70bc8d9680f87559",
  );
  assert.equal(candidate.components.codex.version, "2026.9.9");
  assert.equal(candidate.components.codex.engineVersion, "0.160.0");
  assert.equal(candidate.components.codex.sha256, CODE_SELECTION.companion);
  assert.equal(candidate.companionManifestSha256, CODE_SELECTION.registryManifest);
  assert.match(candidate.companionSourceSha ?? "", /^[0-9a-f]{40}$/u);
  for (const field of ["id", "runId"])
    assert(
      Number.isSafeInteger(candidate.companionArtifact?.[field]) &&
        candidate.companionArtifact[field] > 0,
    );
  assert.match(candidate.companionArtifact?.headSha ?? "", /^[0-9a-f]{40}$/u);
  assert.match(candidate.companionArtifact?.digest ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.equal(typeof candidate.companionArtifact?.name, "string");
  assert(candidate.companionArtifact.name.length > 0);
  assert(
    Number.isSafeInteger(candidate.companionArtifact.sizeBytes) &&
      candidate.companionArtifact.sizeBytes > 0 &&
      candidate.companionArtifact.sizeBytes <= 64 * 1024 * 1024,
    "companion ZIP exceeds bounded transport",
  );
  assert.deepEqual(Object.keys(candidate.locks).sort(), [
    "host.package-lock.json",
    "plugins.package-lock.json",
  ]);
  for (const digest of Object.values(candidate.locks)) assert.match(digest, /^[0-9a-f]{64}$/u);
  for (const field of ["manifestSha256", "binarySha256"])
    assert.match(candidate.codexPlatform?.[field] ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(candidate.codexPlatform.packageVersion, "0.160.0-linux-x64");
  assert.match(
    candidate.codexPlatform.binaryRelativePath ?? "",
    /^vendor\/x86_64-unknown-linux-(?:gnu|musl)\/(?:codex\/codex|bin\/codex)$/u,
  );
  return candidate;
}

export function validateCodeSelection(candidate) {
  assert.equal(candidate.role, "code");
  validateNativeSelection(candidate);
  assert.deepEqual(Object.keys(candidate.components).sort(), ["codex"]);
  assert.equal(candidate.commandCenter, undefined, "Code does not select a CC carrier");
  return candidate;
}

// Final retained CC package/carrier identities are sealed by the source owner.
export const PAIRED_LIFE_SELECTION = Object.freeze({
  source: "d3f3295ffa736b3010b46986126034c0b8a6a812",
  archive: "95a0ce3e167f92d9e9b495ad3ce58186f968f53fe4cc476f229a56cc9b367320",
  build: "700d3849f212d84b4220c8b07b3ea278b187eabef41d99c47c641502a476f997",
  receipt: "cd50659f05a8374f82527570889f2326756323c13776a5a667756fa4589cfb2f",
  artifact: Object.freeze({
    id: 11651544411,
    runId: 38007690805,
    headSha: "d3f3295ffa736b3010b46986126034c0b8a6a812",
    digest: "sha256:fadbcb8570d12d8800d2f9cc6b25de079b23687f6d1a14de78a27285d86f29ab",
    name: "command-center-candidate-d3f3295ffa736b3010b46986126034c0b8a6a812",
    sizeBytes: 3753432,
  }),
  carrier:
    "ghcr.io/ashleyhollis/openclaw-command-center-carrier@sha256:79a25ee724f9e39966e0c4f1b71f9feb85ce91322ed8485dc6c7a079d9018225",
});

export function validatePairedLifeSelection(candidate) {
  assert.equal(candidate.role, "paired-life");
  validateNativeSelection(candidate);
  assert.deepEqual(Object.keys(candidate.components).sort(), ["codex", "qmd"]);
  assert.deepEqual(candidate.components.qmd, {
    version: "2.1.0",
    url: "https://github.com/AshleyHollis/openclaw/releases/download/nas-v2026.7.1-2.6/openclaw-qmd-2.1.0-nas.6.tgz",
    sha256: "4162fcc8812d44246065d121a339554419b55aeb4358fc61ca4acbda753bf28a",
  });
  assert.equal(candidate.companionSourceSha, CODE_SELECTION.source);
  assert.deepEqual(candidate.companionArtifact, {
    id: 11600425043,
    runId: 37893579600,
    headSha: "d7d039c8ed935dce3b207f312307c439e2b9da31",
    digest: "sha256:ceeea7950c43fdbe2b7315220aa1b69783490ef17de4c5a31f5868c325996940",
    name: "docker-e2e-prepublish-plugin-registry-37893579600-1",
    sizeBytes: 15383940,
  });
  assert.deepEqual(candidate.codexPlatform, {
    packageVersion: "0.160.0-linux-x64",
    manifestSha256: "10a2028f277b12091447fb8da260af8703686c9ae2cc52b2fd84a52c1e20883d",
    binarySha256: "12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad",
    binaryRelativePath: "vendor/x86_64-unknown-linux-musl/bin/codex",
  });
  assert.deepEqual(candidate.locks, {
    "host.package-lock.json": "895595bf47269200f5f648b65b76f521c43aaaf4e4a6e133e5ad81e1510b3252",
    "plugins.package-lock.json": "0d2b6109ed0d906811789c6d168138b9ba87192d6371d3b0f1b1d736362636ce",
  });
  for (const field of ["archive", "build", "receipt"])
    assert.match(
      PAIRED_LIFE_SELECTION[field] ?? "",
      /^[0-9a-f]{64}$/u,
      "paired Life CC artifact is not sealed",
    );
  assert.match(
    PAIRED_LIFE_SELECTION.carrier ?? "",
    /^ghcr\.io\/ashleyhollis\/openclaw-command-center-carrier@sha256:[0-9a-f]{64}$/u,
    "paired Life CC carrier is not sealed",
  );
  const cc = candidate.commandCenter;
  assert.equal(cc?.sourceCommit, PAIRED_LIFE_SELECTION.source);
  assert.equal(cc.archiveSha256, PAIRED_LIFE_SELECTION.archive);
  assert.equal(cc.buildDigest, PAIRED_LIFE_SELECTION.build);
  assert.equal(cc.receiptSha256, PAIRED_LIFE_SELECTION.receipt);
  assert.deepEqual(cc.artifact, PAIRED_LIFE_SELECTION.artifact);
  assert.equal(cc.carrierImage, PAIRED_LIFE_SELECTION.carrier);
  return candidate;
}

export function validateRuntimeSelection(candidate) {
  return candidate.role === "code"
    ? validateCodeSelection(candidate)
    : validatePairedLifeSelection(candidate);
}

export function validateRetainedComponentProvenance(
  selection,
  run,
  artifact,
  repository,
  workflowPath,
) {
  assert(Number.isSafeInteger(selection?.id) && selection.id > 0);
  assert(Number.isSafeInteger(selection?.runId) && selection.runId > 0);
  assert.equal(typeof selection.headSha, "string");
  assert.equal(selection.headSha.length, 40);
  assert.match(selection.headSha, /^[0-9a-f]{40}$/u);
  assert.match(selection.digest ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert(
    Number.isSafeInteger(selection.sizeBytes) &&
      selection.sizeBytes > 0 &&
      selection.sizeBytes <= 128 * 1024 * 1024,
  );
  assert.equal(run.id, selection.runId);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  assert.equal(run.head_sha, selection.headSha);
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.path, workflowPath);
  assert.equal(artifact.id, selection.id);
  assert.equal(artifact.name, selection.name);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.digest, selection.digest);
  assert.equal(artifact.workflow_run?.id, selection.runId);
  assert.equal(artifact.workflow_run?.head_sha, selection.headSha);
  assert.equal(artifact.size_in_bytes, selection.sizeBytes);
}

// Authenticated producer/archive bytes are the boundary here. The CC artifact
// owner and existing carrier verify member bytes; do not add another extractor.
export function validateCommandCenterReceipt(cc, receiptBytes, archiveBytes) {
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert(receiptBytes.length <= 4 * 1024 * 1024, "CC receipt exceeds bounded transport");
  assert.equal(sha(receiptBytes), cc.receiptSha256);
  assert.equal(sha(archiveBytes), cc.archiveSha256);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  assert.equal(receipt.formatVersion, 1);
  assert.equal(receipt.kind, "command-center-plugin-artifact");
  assert.equal(receipt.pluginId, "command-center");
  assert.equal(receipt.sourceCommit, cc.sourceCommit);
  assert.equal(receipt.buildDigest, cc.buildDigest);
  assert.deepEqual(receipt.package, { name: "openclaw-command-center", version: "0.4.0" });
  assert.equal(receipt.archive?.sha256, cc.archiveSha256);
  assert.equal(receipt.archive.sizeBytes, archiveBytes.length);
  assert(archiveBytes.length > 0 && archiveBytes.length <= 128 * 1024 * 1024);
  assert(Array.isArray(receipt.files) && receipt.files.length > 0 && receipt.files.length <= 10000);
  const names = new Set();
  let total = 0;
  for (const file of receipt.files) {
    assert.equal(typeof file.path, "string");
    assert(!file.path.includes("\\") && !/[\u0000-\u001f\u007f]/u.test(file.path));
    assert(
      !file.path
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.includes(":")),
    );
    assert(
      ["LICENSE", "package.json", "openclaw.plugin.json"].includes(file.path) ||
        file.path.startsWith("dist/"),
    );
    const key = file.path.normalize("NFC").toLowerCase();
    assert(!names.has(key));
    names.add(key);
    assert.match(file.sha256 ?? "", /^[0-9a-f]{64}$/u);
    assert(Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0);
    total += file.sizeBytes;
    assert(total <= 128 * 1024 * 1024);
  }
  for (const name of [
    "LICENSE",
    "package.json",
    "openclaw.plugin.json",
    "dist/plugin.mjs",
    "dist/.command-center-digest.json",
    "dist/plugin-manifest.json",
    "dist/plugin-config.mjs",
    "dist/compatibility-tuple.json",
  ])
    assert(names.has(name.toLowerCase()));
  return receipt;
}

export function validateRetainedPackageProvenance(candidate, run, artifact) {
  assert(
    Number.isSafeInteger(candidate.hostRunId) && candidate.hostRunId > 0,
    "No authenticated Actions package receipt for the selected candidate; use the reviewed external assembly packet until Root binds one.",
  );
  assert(Number.isSafeInteger(candidate.hostArtifactId) && candidate.hostArtifactId > 0);
  assert.match(candidate.hostRunCommit ?? "", /^[0-9a-f]{40}$/u);
  assert.match(candidate.hostArtifactDigest ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.equal(typeof candidate.hostArtifactName, "string");
  assert(candidate.hostArtifactName.length > 0);
  assert.equal(run.id, candidate.hostRunId);
  assert.equal(run.head_sha, candidate.hostRunCommit);
  assert.equal(run.repository?.full_name, "AshleyHollis/openclaw");
  assert.equal(run.head_repository?.full_name, "AshleyHollis/openclaw");
  assert.equal(run.path, ".github/workflows/build-downstream-artifact.yml");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  assert.equal(artifact.id, candidate.hostArtifactId);
  assert.equal(artifact.name, candidate.hostArtifactName);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.digest, candidate.hostArtifactDigest);
  assert.equal(artifact.workflow_run?.id, run.id);
  assert.equal(artifact.workflow_run?.head_sha, run.head_sha);
}

export function validatePackagedCandidateReceipt(candidate, receipt) {
  assert.match(candidate.hostProducedFrom ?? "", /^[0-9a-f]{40}$/u);
  assert.match(candidate.hostArchiveSha256 ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(receipt.name, "openclaw");
  assert.equal(receipt.source, "ref");
  assert.equal(receipt.packageSourceSha, candidate.hostProducedFrom);
  assert.equal(receipt.packageRef, candidate.hostProducedFrom);
  assert.equal(receipt.version, candidate.hostVersion);
  assert.equal(receipt.sha256, candidate.hostArchiveSha256);
}

export async function validatePackagedCandidate(root, profile = "paired-life") {
  const selected = runtimeSelectionPaths(profile);
  const candidate = JSON.parse(
    await readFile(new URL(`../../${selected.candidate}`, import.meta.url), "utf8"),
  );
  assert.equal(candidate.role, profile);
  validateRuntimeSelection(candidate);
  const receipt = JSON.parse(await readFile(path.join(root, "package-candidate.json"), "utf8"));
  validatePackagedCandidateReceipt(candidate, receipt);
  for (const [name, expected] of Object.entries({
    openclaw: { sha256: candidate.hostArchiveSha256 },
    ...candidate.components,
  })) {
    const bytes = await readFile(path.join(root, `${name}-current.tgz`));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected.sha256,
      `${name} archive changed`,
    );
  }
  return candidate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await validatePackagedCandidate(process.cwd(), process.argv[2]);
}
