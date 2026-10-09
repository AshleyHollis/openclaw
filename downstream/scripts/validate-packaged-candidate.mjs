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
  registryManifest: "f156c4bce7faef83892bce842c39f1cb8ec6158c8cd6293cc01502b0dd58530c",
});

export function runtimeSelectionPaths(profile = "paired-life") {
  assert(["paired-life", "code"].includes(profile), "unknown runtime profile");
  return profile === "code"
    ? { candidate: "downstream/runtime-install/current-code/candidate.json",
        inputRoot: "downstream/runtime-install/current-code", target: "code-runtime" }
    : { candidate: "downstream/runtime-install/candidate.json",
        inputRoot: "downstream/runtime-install/current-host", target: "runtime" };
}

export function validateCodeSelection(candidate) {
  assert.equal(candidate.role, "code");
  assert.equal(candidate.platform, "linux/amd64");
  assert.equal(candidate.hostVersion, "2026.9.9");
  assert.equal(candidate.hostProducedFrom, CODE_SELECTION.source);
  assert.equal(candidate.hostArchiveSha256, CODE_SELECTION.archive);
  assert.equal(candidate.hostRunId, 37873292633);
  assert.equal(candidate.hostRunCommit, "6527403cfe201d0508450ad39c0a985599f2c8b3");
  assert.equal(candidate.hostArtifactId, 11591748081);
  assert.equal(candidate.hostArtifactDigest, "sha256:ee26e271682091ca442d6caa2211adb89a03aeed3f9f34bb70bc8d9680f87559");
  assert.deepEqual(Object.keys(candidate.components).sort(), ["codex"]);
  assert.equal(candidate.components.codex.version, "2026.9.9");
  assert.equal(candidate.components.codex.engineVersion, "0.160.0");
  assert.equal(candidate.components.codex.sha256, CODE_SELECTION.companion);
  assert.equal(candidate.companionManifestSha256, CODE_SELECTION.registryManifest);
  assert.match(candidate.companionSourceSha ?? "", /^[0-9a-f]{40}$/u);
  for (const field of ["id", "runId"]) assert(Number.isSafeInteger(candidate.companionArtifact?.[field]) && candidate.companionArtifact[field] > 0);
  assert.match(candidate.companionArtifact?.headSha ?? "", /^[0-9a-f]{40}$/u);
  assert.match(candidate.companionArtifact?.digest ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.equal(typeof candidate.companionArtifact?.name, "string");
  assert(candidate.companionArtifact.name.length > 0);
  assert(Number.isSafeInteger(candidate.companionArtifact.sizeBytes) && candidate.companionArtifact.sizeBytes > 0 && candidate.companionArtifact.sizeBytes <= 64 * 1024 * 1024, "companion ZIP exceeds bounded transport");
  assert.equal(candidate.commandCenter, undefined, "Code does not select a CC carrier");
  assert.deepEqual(Object.keys(candidate.locks).sort(), ["host.package-lock.json", "plugins.package-lock.json"]);
  for (const digest of Object.values(candidate.locks)) assert.match(digest, /^[0-9a-f]{64}$/u);
  for (const field of ["manifestSha256", "binarySha256"]) assert.match(candidate.codexPlatform?.[field] ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(candidate.codexPlatform.packageVersion, "0.160.0-linux-x64");
  assert.match(candidate.codexPlatform.binaryRelativePath ?? "", /^vendor\/x86_64-unknown-linux-(?:gnu|musl)\/(?:codex\/codex|bin\/codex)$/u);
  return candidate;
}

export function validateRetainedPackageProvenance(candidate, run, artifact) {
  assert(Number.isSafeInteger(candidate.hostRunId) && candidate.hostRunId > 0, "No authenticated Actions package receipt for the selected candidate; use the reviewed external assembly packet until Root binds one.");
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
  if (profile === "code") validateCodeSelection(candidate);
  else assert(candidate.role === undefined || candidate.role === "paired-life", "profile role differs");
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
