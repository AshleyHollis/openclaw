import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  validatePackagedCandidateReceipt,
  validateRetainedPackageProvenance,
  validateRetainedComponentProvenance,
  validateCommandCenterReceipt,
} from "./validate-packaged-candidate.mjs";

test("retained package binds successful trusted workflow and exact artifact", async () => {
  const candidate = JSON.parse(
    await readFile(
      new URL("../runtime-install/history/2026.9.6-candidate.json", import.meta.url),
      "utf8",
    ),
  );
  const run = {
    id: candidate.hostRunId,
    head_sha: candidate.hostRunCommit,
    repository: { full_name: "AshleyHollis/openclaw" },
    head_repository: { full_name: "AshleyHollis/openclaw" },
    path: ".github/workflows/build-downstream-artifact.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
  };
  const artifact = {
    id: candidate.hostArtifactId,
    name: candidate.hostArtifactName,
    expired: false,
    digest: candidate.hostArtifactDigest,
    workflow_run: { id: run.id, head_sha: run.head_sha },
  };
  validateRetainedPackageProvenance(candidate, run, artifact);
  for (const [field, value] of Object.entries({
    id: 1,
    head_sha: "a".repeat(40),
    conclusion: "failure",
    status: "in_progress",
    event: "pull_request",
    path: "other.yml",
    head_repository: { full_name: "fictional/other" },
  })) {
    assert.throws(() =>
      validateRetainedPackageProvenance(candidate, { ...run, [field]: value }, artifact),
    );
  }
  for (const [field, value] of Object.entries({
    id: 1,
    name: "other",
    expired: true,
    digest: `sha256:${"a".repeat(64)}`,
    workflow_run: { id: 1, head_sha: run.head_sha },
  })) {
    assert.throws(() =>
      validateRetainedPackageProvenance(candidate, run, { ...artifact, [field]: value }),
    );
  }
});

// Engineering archives are exact bytes, not an authenticated Actions artifact.
test("missing Actions provenance cannot pass by comparing absent identities", async () => {
  const candidate = JSON.parse(
    await readFile(new URL("../runtime-install/candidate.json", import.meta.url), "utf8"),
  );
  assert.throws(
    () => validateRetainedPackageProvenance(candidate, {}, {}),
    /No authenticated Actions package receipt/,
  );
});

// A package producer is not the later source head or a historical archive pin.
test("package receipt binds canonical producer and archive, rejecting absent or stale fields", () => {
  const candidate = {
    hostProducedFrom: "a".repeat(40),
    sourceHead: "b".repeat(40),
    hostArchiveSha256: "c".repeat(64),
    hostVersion: "2026.9.8",
  };
  const receipt = {
    name: "openclaw",
    source: "ref",
    packageSourceSha: candidate.hostProducedFrom,
    packageRef: candidate.hostProducedFrom,
    version: candidate.hostVersion,
    sha256: candidate.hostArchiveSha256,
  };
  validatePackagedCandidateReceipt(candidate, receipt);
  for (const [field, value] of Object.entries({
    packageSourceSha: candidate.sourceHead,
    packageRef: candidate.sourceHead,
    version: "2026.9.6",
    sha256: "d".repeat(64),
  })) {
    assert.throws(() =>
      validatePackagedCandidateReceipt(candidate, { ...receipt, [field]: value }),
    );
  }
  assert.throws(() =>
    validatePackagedCandidateReceipt(
      { hostVersion: candidate.hostVersion },
      { name: "openclaw", source: "ref", version: candidate.hostVersion },
    ),
  );
});

// Fictional Actions/receipt bytes prove transport admission, not an installed CC.
test("component producer rejects detached repository, workflow, head and artifact closure", () => {
  const a = {
    id: 10,
    runId: 20,
    headSha: "a".repeat(40),
    digest: "sha256:" + "b".repeat(64),
    name: "fictional",
    sizeBytes: 100,
  };
  const repo = "AshleyHollis/openclaw-command-center",
    workflow = ".github/workflows/package-candidate.yml";
  const run = {
    id: a.runId,
    head_sha: a.headSha,
    repository: { full_name: repo },
    head_repository: { full_name: repo },
    path: workflow,
    status: "completed",
    conclusion: "success",
  };
  const artifact = {
    id: a.id,
    name: a.name,
    digest: a.digest,
    size_in_bytes: a.sizeBytes,
    expired: false,
    workflow_run: { id: a.runId, head_sha: a.headSha },
  };
  validateRetainedComponentProvenance(a, run, artifact, repo, workflow);
  for (const patch of [
    { id: 21 },
    { path: "other.yml" },
    { status: "queued" },
    { conclusion: "failure" },
    { head_sha: "c".repeat(40) },
    { repository: { full_name: "fictional/other" } },
    { head_repository: { full_name: "fictional/other" } },
  ])
    assert.throws(() =>
      validateRetainedComponentProvenance(a, { ...run, ...patch }, artifact, repo, workflow),
    );
  for (const patch of [
    { id: 11 },
    { name: "other" },
    { digest: "sha256:" + "c".repeat(64) },
    { size_in_bytes: 101 },
    { expired: true },
    { workflow_run: { id: 21, head_sha: a.headSha } },
    { workflow_run: { id: a.runId, head_sha: "c".repeat(40) } },
  ])
    assert.throws(() =>
      validateRetainedComponentProvenance(a, run, { ...artifact, ...patch }, repo, workflow),
    );
  for (const patch of [
    { headSha: a.headSha + "\n" },
    { id: 0 },
    { runId: 0 },
    { sizeBytes: 128 * 1024 * 1024 + 1 },
  ])
    assert.throws(() =>
      validateRetainedComponentProvenance({ ...a, ...patch }, run, artifact, repo, workflow),
    );
});

test("CC receipt binds raw bytes and complete bounded manifest before carrier verification", () => {
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const archive = Buffer.from("fictional already-authenticated CC archive");
  const files = [
    "LICENSE",
    "package.json",
    "openclaw.plugin.json",
    "dist/plugin.mjs",
    "dist/.command-center-digest.json",
    "dist/plugin-manifest.json",
    "dist/plugin-config.mjs",
    "dist/compatibility-tuple.json",
  ].map((path) => ({ path, sizeBytes: 1, sha256: "e".repeat(64) }));
  const receipt = {
    formatVersion: 1,
    kind: "command-center-plugin-artifact",
    pluginId: "command-center",
    package: { name: "openclaw-command-center", version: "0.4.0" },
    sourceCommit: "a".repeat(40),
    buildDigest: "b".repeat(64),
    files,
    archive: { sha256: hash(archive), sizeBytes: archive.length },
  };
  const raw = Buffer.from(JSON.stringify(receipt));
  const cc = {
    sourceCommit: receipt.sourceCommit,
    buildDigest: receipt.buildDigest,
    archiveSha256: hash(archive),
    receiptSha256: hash(raw),
  };
  assert.deepEqual(validateCommandCenterReceipt(cc, raw, archive), receipt);
  assert.throws(() =>
    validateCommandCenterReceipt(cc, Buffer.from(JSON.stringify(receipt, null, 2)), archive),
  );
  assert.throws(() => validateCommandCenterReceipt(cc, raw, Buffer.from("changed")));
  for (const mutate of [
    (r) => (r.sourceCommit = "c".repeat(40)),
    (r) => (r.buildDigest = "c".repeat(64)),
    (r) => r.archive.sizeBytes++,
    (r) => (r.package.version = "0.5.0"),
    (r) => r.files.pop(),
    (r) => r.files.push(r.files[0]),
    (r) => (r.files[0].path = "../LICENSE"),
    (r) => (r.files[0].path = "dist/x\\y"),
    (r) => (r.files[0].path = "dist/x\ny"),
    (r) => (r.files[0].sizeBytes = 128 * 1024 * 1024 + 1),
    (r) => (r.files[0].sha256 = "invalid"),
  ]) {
    const r = structuredClone(receipt);
    mutate(r);
    const bytes = Buffer.from(JSON.stringify(r));
    assert.throws(() =>
      validateCommandCenterReceipt({ ...cc, receiptSha256: hash(bytes) }, bytes, archive),
    );
  }
});
