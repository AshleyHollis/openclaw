import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const materializeScript = path.join(repositoryRoot, "downstream/scripts/materialize-repair.mjs");
const repackScript = path.join(repositoryRoot, "downstream/scripts/repack-official-tarball.sh");
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

test("repacks an official package tree without executing lifecycle scripts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-repack-test-"));
  const packageRoot = path.join(root, "package");
  const output = path.join(root, "openclaw.tgz");
  try {
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.7.1-2",
        scripts: { prepare: "node prepare.mjs" },
      }),
    );
    await writeFile(
      path.join(packageRoot, "prepare.mjs"),
      'import { writeFileSync } from "node:fs"; writeFileSync("prepare-ran", "unsafe");\n',
    );
    await writeFile(path.join(packageRoot, "dist/index.js"), "export {};\n");

    const result = spawnSync("bash", [repackScript, packageRoot, output, "0"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(readFile(path.join(packageRoot, "prepare-ran")), { code: "ENOENT" });
    const entries = execFileSync("tar", ["-tzf", output], { encoding: "utf8" }).trim().split("\n");
    assert.ok(entries.includes("package/package.json"));
    assert.ok(entries.includes("package/dist/index.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("produces byte-identical package archives from the same staged tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-repack-repeat-test-"));
  const packageRoot = path.join(root, "package");
  const first = path.join(root, "first.tgz");
  const second = path.join(root, "second.tgz");
  try {
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }),
    );
    await writeFile(path.join(packageRoot, "dist/index.js"), "export {};\n");

    for (const output of [first, second]) {
      const result = spawnSync("bash", [repackScript, packageRoot, output, "1721260800"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.deepEqual(await readFile(first), await readFile(second));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe entries and local dependencies in a staged package tree", async (t) => {
  await t.test("symbolic link", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-repack-link-test-"));
    const packageRoot = path.join(root, "package");
    try {
      await mkdir(packageRoot);
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }),
      );
      await symlink("package.json", path.join(packageRoot, "linked-package.json"));
      const result = spawnSync(
        "bash",
        [repackScript, packageRoot, path.join(root, "openclaw.tgz"), "0"],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unsupported filesystem entry/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("local dependency", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-repack-dependency-test-"));
    const packageRoot = path.join(root, "package");
    try {
      await mkdir(packageRoot);
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2026.7.1-2",
          dependencies: { unsafe: "file:../unsafe" },
        }),
      );
      const result = spawnSync(
        "bash",
        [repackScript, packageRoot, path.join(root, "openclaw.tgz"), "0"],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /forbidden local dependency/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("validates the release manifest and patch hashes", () => {
  const result = spawnSync(
    process.execPath,
    [
      validateScript,
      "downstream/releases/2026.7.1-2.json",
      "downstream/releases/2026.7.1-2-nas.2.json",
      "downstream/releases/2026.7.1-2-nas.3.json",
      "downstream/releases/2026.7.1-2-nas.4.json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2026\.7\.1-2\+nas\.1 \(blocked\)/u);
  assert.match(result.stdout, /2026\.7\.1-2\+nas\.2 \(blocked\)/u);
  assert.match(result.stdout, /2026\.7\.1-2\+nas\.3 \(blocked\)/u);
  assert.match(result.stdout, /2026\.7\.1-2\+nas\.4 \(candidate\)/u);
});

test("builds and smokes the exact Codex artifact inside the runtime image", async () => {
  const dockerfile = await readFile(
    path.join(repositoryRoot, "downstream/Dockerfile.artifact"),
    "utf8",
  );
  const workflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/build-downstream-artifact.yml"),
    "utf8",
  );
  assert.match(dockerfile, /ARG CODEX_TARBALL_SHA256/u);
  assert.match(dockerfile, /COPY codex-current\.tgz/u);
  assert.match(dockerfile, /CODEX_TARBALL_SHA256.*sha256sum/u);
  assert.match(dockerfile, /\/opt\/openclaw-plugin-runtime/u);
  assert.match(workflow, /CODEX_TARBALL_SHA256=.*codex_artifact_sha256/u);
  assert.match(workflow, /smoke-image-runtime\.mjs/u);
  assert.doesNotMatch(workflow, /name: Smoke-test local image\n\s+if:/u);
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
  assert.equal(manifest.status, "candidate");
  assert.equal(manifest.artifact.validation.externalPluginRegistration, true);
  assert.equal(manifest.artifact.validation.scopedLoopbackRpc, true);
  assert.equal(manifest.artifact.validation.dependencyMetadataCheck, true);
  assert.equal(manifest.artifact.validation.imageSmoke, false);
  assert.equal(manifest.artifact.validation.imageScan, false);
  assert.match(manifest.externalPlugins[0].artifact.url, /nas-v2026\.7\.1-2\.4/u);
  assert.equal(manifest.image.digest, undefined);
});
