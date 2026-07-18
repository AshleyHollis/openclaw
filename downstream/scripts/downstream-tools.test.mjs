import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const materializeScript = path.join(repositoryRoot, "downstream/scripts/materialize-repair.mjs");
const validateScript = path.join(repositoryRoot, "downstream/scripts/validate-release.mjs");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createRepairFixture(relativeFile, updated) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-repair-test-"));
  const file = path.join(root, relativeFile);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "before\n");
  git(root, "init");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Downstream Test");
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture");
  await writeFile(file, updated);
  const patch = git(root, "diff", "--binary");
  git(root, "checkout", "--", relativeFile);
  return { patch, root };
}

test("materializes an application-source-only repair", async () => {
  const fixture = await createRepairFixture("src/example.ts", "after\n");
  try {
    const result = spawnSync(process.execPath, [materializeScript], {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_REPAIR_JSON: JSON.stringify({ summary: "safe repair", patch: fixture.patch }),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /src\/example\.ts/u);
    const content = await readFile(path.join(fixture.root, "src/example.ts"), "utf8");
    assert.equal(content.replaceAll("\r\n", "\n"), "after\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a repair that changes a package manifest", async () => {
  const fixture = await createRepairFixture("package.json", "{}\n");
  try {
    const result = spawnSync(process.execPath, [materializeScript], {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_REPAIR_JSON: JSON.stringify({ summary: "unsafe repair", patch: fixture.patch }),
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden path: package\.json/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("validates the release manifest and patch hashes", () => {
  const result = spawnSync(
    process.execPath,
    [
      validateScript,
      "downstream/releases/2026.7.1-2.json",
      "downstream/releases/2026.7.1-2-nas.2.json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2026\.7\.1-2\+nas\.1 \(blocked\)/u);
  assert.match(result.stdout, /2026\.7\.1-2\+nas\.2 \(blocked\)/u);
});

test("keeps the latest pointer aligned with the selected manifest", async () => {
  const pointer = JSON.parse(
    await readFile(path.join(repositoryRoot, "downstream/releases/latest.json"), "utf8"),
  );
  assert.match(pointer.releaseManifest, /^downstream\/releases\/[0-9A-Za-z._+-]+\.json$/u);
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, pointer.releaseManifest), "utf8"),
  );
  assert.equal(pointer.status, manifest.status);
  assert.equal(manifest.status, "blocked");
  assert.ok(manifest.blockingIssues.length > 0);
  assert.equal(manifest.artifact.validation.externalPluginRegistration, true);
  assert.equal(manifest.artifact.validation.scopedLoopbackRpc, true);
  assert.equal(manifest.artifact.validation.dependencyMetadataCheck, false);
  assert.match(manifest.externalPlugins[0].artifact.url, /nas-v2026\.7\.1-2\.2/u);
});
