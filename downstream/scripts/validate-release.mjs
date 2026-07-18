#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const sha256Pattern = /^[0-9a-f]{64}$/u;
const gitShaPattern = /^[0-9a-f]{40}$/u;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/u;
const allowedStatuses = new Set(["preserved", "candidate", "blocked", "qualified"]);
const allowedPatchStatuses = new Set(["required", "superseded", "obsolete", "conflicting"]);

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function requireString(value, label) {
  requireCondition(
    typeof value === "string" && value.length > 0,
    `${label} must be a non-empty string`,
  );
}

function requireDivergence(value, label) {
  requireCondition(value && typeof value === "object", `${label} must be an object`);
  for (const field of ["ahead", "behind"]) {
    requireCondition(
      Number.isInteger(value[field]) && value[field] >= 0,
      `${label}.${field} must be a non-negative integer`,
    );
  }
}

async function sha256File(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function validatePatch(root, patch, index) {
  const label = `patches[${index}]`;
  requireString(patch?.id, `${label}.id`);
  requireString(patch?.file, `${label}.file`);
  requireCondition(sha256Pattern.test(patch?.sha256 ?? ""), `${label}.sha256 is invalid`);
  requireCondition(allowedPatchStatuses.has(patch?.status), `${label}.status is invalid`);
  requireCondition(
    Array.isArray(patch?.tests) && patch.tests.length > 0,
    `${label}.tests must not be empty`,
  );
  const patchPath = path.resolve(root, patch.file);
  requireCondition(
    patchPath.startsWith(path.resolve(root, "downstream", "patches") + path.sep),
    `${label}.file must stay under downstream/patches`,
  );
  const actual = await sha256File(patchPath);
  requireCondition(actual === patch.sha256, `${label}.sha256 does not match ${patch.file}`);
}

async function validateRelease(manifestPath) {
  const root = process.cwd();
  const manifest = JSON.parse(await readFile(path.resolve(root, manifestPath), "utf8"));
  requireCondition(manifest.schemaVersion === 1, "schemaVersion must be 1");
  requireString(manifest.releaseId, "releaseId");
  requireCondition(allowedStatuses.has(manifest.status), "status is invalid");
  if (manifest.status === "blocked") {
    requireCondition(
      Array.isArray(manifest.blockingIssues) && manifest.blockingIssues.length > 0,
      "blocked release requires blockingIssues",
    );
    for (const [index, issue] of manifest.blockingIssues.entries()) {
      requireString(issue, `blockingIssues[${index}]`);
    }
  } else {
    requireCondition(
      manifest.blockingIssues === undefined,
      "only blocked releases may define blockingIssues",
    );
  }
  requireString(manifest.npm?.version, "npm.version");
  requireCondition(manifest.npm?.distTag === "latest", "npm.distTag must be latest");
  requireCondition(
    manifest.npm?.integrity?.startsWith("sha512-"),
    "npm.integrity must be sha512 SRI",
  );
  requireCondition(
    manifest.npm?.tarball?.startsWith("https://registry.npmjs.org/openclaw/-/"),
    "npm.tarball must be the official OpenClaw registry URL",
  );
  requireString(manifest.source?.ref, "source.ref");
  requireCondition(
    gitShaPattern.test(manifest.source?.baseCommit ?? ""),
    "source.baseCommit is invalid",
  );
  requireCondition(gitShaPattern.test(manifest.source?.commit ?? ""), "source.commit is invalid");
  requireDivergence(manifest.source?.stableDivergence, "source.stableDivergence");
  requireDivergence(manifest.source?.mainDivergence, "source.mainDivergence");
  requireString(manifest.node?.buildVersion, "node.buildVersion");
  requireString(manifest.node?.engine, "node.engine");
  requireCondition(
    Array.isArray(manifest.externalPlugins) && manifest.externalPlugins.length > 0,
    "externalPlugins must not be empty",
  );
  const externalPluginIds = new Set();
  for (const [index, plugin] of manifest.externalPlugins.entries()) {
    const label = `externalPlugins[${index}]`;
    requireString(plugin?.id, `${label}.id`);
    requireCondition(!externalPluginIds.has(plugin.id), `${label}.id must be unique`);
    externalPluginIds.add(plugin.id);
    requireCondition(
      /^@openclaw\/[a-z0-9-]+$/u.test(plugin?.package ?? ""),
      `${label}.package is invalid`,
    );
    requireString(plugin?.version, `${label}.version`);
    requireCondition(
      plugin?.integrity?.startsWith("sha512-"),
      `${label}.integrity must be sha512 SRI`,
    );
    requireCondition(
      plugin?.tarball?.startsWith("https://registry.npmjs.org/@openclaw/"),
      `${label}.tarball must be an official OpenClaw registry URL`,
    );
    if (plugin?.artifact !== null && plugin?.artifact !== undefined) {
      requireString(plugin.artifact.filename, `${label}.artifact.filename`);
      requireCondition(
        plugin.artifact.url?.startsWith(
          "https://github.com/AshleyHollis/openclaw/releases/download/",
        ),
        `${label}.artifact.url must be an AshleyHollis/openclaw release asset`,
      );
      requireCondition(
        sha256Pattern.test(plugin.artifact.sha256 ?? ""),
        `${label}.artifact.sha256 is invalid`,
      );
    }
    if (manifest.status === "candidate" || manifest.status === "qualified") {
      requireCondition(
        plugin?.artifact && typeof plugin.artifact === "object",
        `${label}.artifact is required for ${manifest.status} releases`,
      );
    }
  }
  requireCondition(
    Array.isArray(manifest.patches) && manifest.patches.length > 0,
    "patches must not be empty",
  );
  await Promise.all(manifest.patches.map((patch, index) => validatePatch(root, patch, index)));
  requireString(manifest.artifact?.filename, "artifact.filename");
  requireCondition(
    manifest.artifact?.url?.startsWith(
      "https://github.com/AshleyHollis/openclaw/releases/download/",
    ),
    "artifact.url must be an AshleyHollis/openclaw release asset",
  );
  requireCondition(
    sha256Pattern.test(manifest.artifact?.sha256 ?? ""),
    "artifact.sha256 is invalid",
  );
  requireCondition(
    manifest.image?.repository === "ghcr.io/ashleyhollis/openclaw",
    "image.repository is invalid",
  );
  if (manifest.status === "qualified") {
    requireCondition(
      imageDigestPattern.test(manifest.image?.digest ?? ""),
      "qualified release requires image.digest",
    );
    requireCondition(
      imageDigestPattern.test(manifest.image?.attestationDigest ?? ""),
      "qualified release requires image.attestationDigest",
    );
    requireCondition(
      imageDigestPattern.test(manifest.image?.sbomDigest ?? ""),
      "qualified release requires image.sbomDigest",
    );
    requireCondition(
      imageDigestPattern.test(manifest.image?.provenanceDigest ?? ""),
      "qualified release requires image.provenanceDigest",
    );
    requireCondition(
      manifest.artifact?.validation?.fullBuild === true,
      "qualified release requires full build proof",
    );
    requireCondition(
      manifest.artifact?.validation?.packageSmoke === true,
      "qualified release requires package smoke proof",
    );
    requireCondition(
      manifest.artifact?.validation?.externalPluginRegistration === true,
      "qualified release requires external plugin registration proof",
    );
    requireCondition(
      manifest.artifact?.validation?.scopedLoopbackRpc === true,
      "qualified release requires scoped loopback RPC proof",
    );
    requireCondition(
      manifest.artifact?.validation?.dependencyMetadataCheck === true,
      "qualified release requires dependency metadata proof",
    );
    requireCondition(
      manifest.artifact?.validation?.patchTests === true,
      "qualified release requires patch tests",
    );
    requireCondition(
      manifest.artifact?.validation?.imageSmoke === true,
      "qualified release requires image smoke proof",
    );
    requireCondition(
      manifest.artifact?.validation?.imageScan === true,
      "qualified release requires image scan proof",
    );
    for (const result of ["downstreamGuard", "dryRun", "publish"]) {
      requireCondition(
        manifest.testResults?.[result]?.startsWith(
          "https://github.com/AshleyHollis/openclaw/actions/runs/",
        ),
        `qualified release requires testResults.${result}`,
      );
    }
  }
  return manifest;
}

const manifests = process.argv.slice(2);
if (manifests.length === 0) {
  console.error("Usage: node downstream/scripts/validate-release.mjs <manifest.json> [...]");
  process.exit(2);
}

for (const manifestPath of manifests) {
  const manifest = await validateRelease(manifestPath);
  console.log(`${manifestPath}: ${manifest.releaseId} (${manifest.status})`);
}
