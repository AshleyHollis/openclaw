#!/usr/bin/env node

// Guards pnpm package patches against unapproved additions.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const ALLOWED_PATCHED_DEPENDENCIES = new Map([
  // Remove after fs-safe ships pinned-write fsync with best-effort EPERM handling.
  ["@openclaw/fs-safe@0.4.1", "patches/@openclaw__fs-safe@0.4.1.patch"],
  ["baileys@7.0.0-rc12", "patches/baileys@7.0.0-rc12.patch"],
  ["baileys@7.0.0-rc13", "patches/baileys@7.0.0-rc13.patch"],
]);

const ALLOWED_PATCH_FILES = new Set(["patches/.gitkeep", ...ALLOWED_PATCHED_DEPENDENCIES.values()]);

function listTrackedFiles(cwd, patterns) {
  return execFileSync("git", ["ls-files", "-z", "--", ...patterns], {
    cwd,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

function readYamlFile(cwd, relativePath) {
  const filePath = path.join(cwd, relativePath);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return YAML.parse(fs.readFileSync(filePath, "utf8")) ?? {};
}

function readJsonFile(cwd, relativePath, expectedDigest) {
  const filePath = path.join(cwd, relativePath);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const content = fs.readFileSync(filePath, "utf8");
  if (expectedDigest && createHash("sha256").update(content).digest("hex") !== expectedDigest) {
    return undefined;
  }
  return JSON.parse(content);
}

function collectPatchedDependencyViolations(file, patchedDependencies, violations, options = {}) {
  for (const [specifier, patchPathOrHash] of Object.entries(patchedDependencies ?? {})) {
    if (
      options.allowAnyValueForLegacy === true
        ? ALLOWED_PATCHED_DEPENDENCIES.has(specifier)
        : ALLOWED_PATCHED_DEPENDENCIES.get(specifier) === patchPathOrHash
    ) {
      continue;
    }
    violations.push({
      file,
      kind: "patchedDependency",
      detail: `${specifier} -> ${String(patchPathOrHash)}`,
    });
  }
}

function collectWorkspacePatchViolations(cwd, violations) {
  const workspace = readYamlFile(cwd, "pnpm-workspace.yaml");
  collectPatchedDependencyViolations(
    "pnpm-workspace.yaml",
    workspace?.patchedDependencies,
    violations,
  );
}

function collectLockfilePatchViolations(cwd, violations) {
  const lockfile = readYamlFile(cwd, "pnpm-lock.yaml");
  collectPatchedDependencyViolations("pnpm-lock.yaml", lockfile?.patchedDependencies, violations, {
    allowAnyValueForLegacy: true,
  });
}

function collectPackageJsonPatchViolations(cwd, violations) {
  for (const relativePath of listTrackedFiles(cwd, ["*package.json"])) {
    const packageJson = readJsonFile(cwd, relativePath);
    const patchedDependencies = packageJson?.pnpm?.patchedDependencies;
    for (const [specifier, patchPath] of Object.entries(patchedDependencies ?? {})) {
      violations.push({
        file: relativePath,
        kind: "packageJsonPatchedDependency",
        detail: `${specifier} -> ${String(patchPath)}`,
      });
    }
  }
}

function collectPatchFileViolations(cwd, violations) {
  // These historical Git source exports are not pnpm patches. Reuse their
  // fixed release inventory and byte hashes; declarations remain forbidden.
  // Anchor the manifest too: editing both a patch and its hash is not approval.
  const archivedPatches =
    readJsonFile(
      cwd,
      "downstream/releases/2026.7.1-2-nas.7.json",
      "4cd47c074a8bc1a6b86940a2a0c78706d1163c81dfa0714191478183afcee5f4",
    )?.patches ?? [];
  for (const relativePath of listTrackedFiles(cwd, ["*.patch"])) {
    if (!fs.existsSync(path.join(cwd, relativePath))) {
      continue;
    }
    if (ALLOWED_PATCH_FILES.has(relativePath)) {
      continue;
    }
    const archivedHash = archivedPatches.find((patch) => patch.file === relativePath)?.sha256;
    if (
      relativePath.startsWith("downstream/patches/2026.7.1-2/") &&
      typeof archivedHash === "string" &&
      /^[a-f0-9]{64}$/.test(archivedHash) &&
      createHash("sha256")
        .update(fs.readFileSync(path.join(cwd, relativePath)))
        .digest("hex") === archivedHash
    ) {
      continue;
    }
    violations.push({
      file: relativePath,
      kind: "patchFile",
      detail: "new package patch file",
    });
  }
}

/**
 * Collects disallowed package patch declarations and patch files.
 */
export function collectPackagePatchViolations(cwd = process.cwd()) {
  const violations = [];
  collectWorkspacePatchViolations(cwd, violations);
  collectLockfilePatchViolations(cwd, violations);
  collectPackageJsonPatchViolations(cwd, violations);
  collectPatchFileViolations(cwd, violations);
  return violations;
}

/**
 * Runs the package patch guard.
 */
export async function main() {
  const violations = collectPackagePatchViolations();
  if (violations.length === 0) {
    process.stdout.write(
      `PASS package patch guard: no new pnpm patches; ${ALLOWED_PATCHED_DEPENDENCIES.size} approved patches allowlisted.\n`,
    );
    return;
  }

  console.error(
    "FAIL package patch guard: new pnpm package patches are not allowed. Upstream the fix, publish a new package version, then bump the dependency instead.",
  );
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.kind}: ${violation.detail}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
