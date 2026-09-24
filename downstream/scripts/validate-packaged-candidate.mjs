import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function validateRetainedPackageProvenance(candidate, run, artifact) {
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

export async function validatePackagedCandidate(root) {
  const candidate = JSON.parse(
    await readFile(new URL("../runtime-install/candidate.json", import.meta.url), "utf8"),
  );
  const receipt = JSON.parse(await readFile(path.join(root, "package-candidate.json"), "utf8"));
  assert.equal(receipt.name, "openclaw");
  assert.equal(receipt.source, "ref");
  assert.equal(receipt.packageSourceSha, candidate.sourceCommit);
  assert.equal(receipt.packageRef, candidate.sourceCommit);
  assert.equal(receipt.version, candidate.hostVersion);
  assert.equal(receipt.sha256, candidate.hostSha256);
  for (const [name, expected] of Object.entries({
    openclaw: { sha256: candidate.hostSha256 },
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
  await validatePackagedCandidate(process.cwd());
}
