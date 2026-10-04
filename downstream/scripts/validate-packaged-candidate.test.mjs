import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateRetainedPackageProvenance } from "./validate-packaged-candidate.mjs";

test("retained package binds successful trusted workflow and exact artifact", async () => {
  const candidate = JSON.parse(
    await readFile(new URL("../runtime-install/candidate.json", import.meta.url), "utf8"),
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
