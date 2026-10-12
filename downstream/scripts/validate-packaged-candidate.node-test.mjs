import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  validatePackagedCandidateReceipt,
  validateRetainedPackageProvenance,
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
