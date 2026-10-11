import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const isSha = (value) => /^[0-9a-f]{40}$/u.test(value ?? "");
const NATIVE_MARKER =
  /\b(?:configureFsSafeNative|getFsSafeNativeConfig|getNativeBinding)\b|@openclaw\/fs-safe\/native/u;
function hasBundledNativeBinding(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version ?? "");
  if (!match) {
    return false;
  }
  const [, major, minor, patch] = match.map(Number);
  return major === 0 && (minor === 5 || (minor === 4 && patch >= 2));
}

function listContainingBranches(ref) {
  try {
    const branches = execFileSync(
      "git",
      [
        "for-each-ref",
        "--format=%(refname:short)",
        "--contains",
        ref,
        "refs/remotes/origin/extended-stable",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return branches.split("\n");
  } catch {
    return [];
  }
}

export function resolveFsSafeNativeContract({
  selectedSha,
  workflowSha,
  allowFrozenSource,
  containingBranches,
  readSource,
}) {
  assert.ok(isSha(selectedSha), "ref must be a full lowercase commit SHA");
  assert.ok(isSha(workflowSha), "workflow SHA must be a full lowercase commit SHA");
  if (
    !allowFrozenSource ||
    selectedSha === workflowSha ||
    !containingBranches().some((branch) =>
      /^origin\/extended-stable\/\d{4}\.(?:[1-9]|1[0-2])\.33$/u.test(branch),
    )
  ) {
    return "required";
  }
  const packageSource = readSource("package.json");
  if (packageSource === null) {
    throw new Error("missing fs-safe package source");
  }
  const packageJson = JSON.parse(packageSource);
  const fsSafeVersion = packageJson.dependencies?.["@openclaw/fs-safe"];
  const bundledNative = hasBundledNativeBinding(fsSafeVersion);
  if (!bundledNative) {
    return "required";
  }
  const defaults = readSource("src/infra/fs-safe-defaults.ts");
  if (defaults === null) {
    throw new Error("missing fs-safe defaults source");
  }
  if (bundledNative && NATIVE_MARKER.test(defaults)) {
    return "bundled";
  }
  return "required";
}

export function resolveFsSafePublicationContract({
  selectedSha,
  workflowSha,
  allowFrozenSource,
  containingBranches,
  readSource,
}) {
  assert.ok(isSha(selectedSha), "ref must be a full lowercase commit SHA");
  assert.ok(isSha(workflowSha), "workflow SHA must be a full lowercase commit SHA");
  const source = readSource("package.json");
  if (source === null) {
    throw new Error("missing fs-safe publication package source");
  }
  const manifest = JSON.parse(source);
  const version = manifest.dependencies?.["@openclaw/fs-safe"];
  if (version === "0.24.2") {
    const bundles = manifest.bundleDependencies ?? manifest.bundledDependencies;
    assert.ok(
      bundles === true || (Array.isArray(bundles) && bundles.includes("@openclaw/fs-safe")),
      "patched fs-safe publication must be bundled",
    );
    const patchPath = "patches/@openclaw__fs-safe@0.24.2.patch";
    const workspace = readSource("pnpm-workspace.yaml") ?? "";
    assert.match(
      workspace,
      /["']?@openclaw\/fs-safe@0\.24\.2["']?:\s*patches\/@openclaw__fs-safe@0\.24\.2\.patch/u,
      "missing exact fs-safe publication patch registration",
    );
    const patch = readSource(patchPath);
    assert.ok(patch !== null, "missing fs-safe publication patch source");
    assert.equal(
      createHash("sha256").update(patch).digest("hex"),
      "c399b3eeebbcb7a5a99e958ad70ac6bb25d395365d91af3519bc75cca37e1dcd",
      "changed fs-safe publication patch source",
    );
    return "required";
  }
  // Only a canonical historical target can omit an API it predates.
  const historicalVersion = /^0\.(\d+)\.\d+$/u.exec(version ?? "");
  if (
    historicalVersion &&
    Number(historicalVersion[1]) < 24 &&
    allowFrozenSource &&
    selectedSha !== workflowSha &&
    containingBranches().some((branch) =>
      /^origin\/extended-stable\/\d{4}\.(?:[1-9]|1[0-2])\.33$/u.test(branch),
    )
  ) {
    return "not-applicable";
  }
  return "required";
}

let invokedAsMain = false;
if (process.argv[1]) {
  try {
    invokedAsMain =
      realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(process.argv[1]);
  } catch {
    // Inline and stdin importers need not have a filesystem entrypoint.
  }
}

// A canonical frozen release source may omit a proof for functionality it cannot use.
// Current, unknown, and native-consuming sources always verify the installed package.
if (invokedAsMain) {
  const [ref, workflowSha, allowFrozenSource] = process.argv.slice(2);
  assert.ok(isSha(ref), "ref must be a full lowercase commit SHA");
  assert.ok(isSha(workflowSha), "workflow SHA must be a full lowercase commit SHA");
  let contract = "required";
  try {
    contract = resolveFsSafeNativeContract({
      selectedSha: ref,
      workflowSha,
      allowFrozenSource: allowFrozenSource === "1",
      containingBranches: () => listContainingBranches(ref),
      readSource: (path) =>
        execFileSync("git", ["show", `${ref}:${path}`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
    });
  } catch {
    // Standalone checks remain strict on unknown source; admission propagates errors.
  }
  process.stdout.write(`${contract}\n`);
}
