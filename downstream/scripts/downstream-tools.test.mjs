import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repackScript = path.join(repositoryRoot, "downstream/scripts/repack-official-tarball.sh");
const validatePackedMetadataScript = path.join(
  repositoryRoot,
  "downstream/scripts/validate-packed-metadata.mjs",
);
const validateScript = path.join(repositoryRoot, "downstream/scripts/validate-release.mjs");

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
      "downstream/releases/2026.7.1-2-nas.5.json",
      "downstream/releases/2026.7.1-2-nas.6.json",
      "downstream/releases/2026.7.1-2-nas.7.json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2026\.7\.1-2\+nas\.1 \(blocked\)/u);
  assert.match(result.stdout, /2026\.7\.1-2\+nas\.2 \(blocked\)/u);
  assert.match(result.stdout, /2026\.7\.1-2\+nas\.3 \(blocked\)/u);
  assert.match(result.stdout, /2026\.7\.1-2\+nas\.4 \(blocked\)/u);
  assert.match(result.stdout, /2026\.7\.1-2\+nas\.5 \(qualified\)/u);
  assert.match(result.stdout, /2026\.7\.1-2\+nas\.6 \(qualified\)/u);
  assert.match(result.stdout, /2026\.7\.1-2\+nas\.7 \(qualified\)/u);
});

test("validates packed runtime metadata before dependency installation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openclaw-packed-metadata-test-"));
  try {
    const packagePath = path.join(directory, "package.json");
    const shrinkwrapPath = path.join(directory, "npm-shrinkwrap.json");
    await writeFile(
      packagePath,
      JSON.stringify({
        name: "@openclaw/codex",
        version: "1.2.3",
        dependencies: { zod: "4.4.3" },
      }),
    );
    await writeFile(
      shrinkwrapPath,
      JSON.stringify({
        name: "@openclaw/codex",
        version: "1.2.3",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "@openclaw/codex",
            version: "1.2.3",
            dependencies: { zod: "4.4.3" },
          },
          "node_modules/zod": {
            version: "4.4.3",
            resolved: "https://registry.npmjs.org/zod/-/zod-4.4.3.tgz",
            integrity: "sha512-test",
          },
        },
      }),
    );
    const result = spawnSync(
      process.execPath,
      [validatePackedMetadataScript, packagePath, shrinkwrapPath, "@openclaw/codex", "1.2.3"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /packed metadata valid/u);

    const invalidManifest = JSON.parse(await readFile(packagePath, "utf8"));
    const invalidShrinkwrap = JSON.parse(await readFile(shrinkwrapPath, "utf8"));
    invalidManifest.dependencies.zod = "file:../zod";
    invalidShrinkwrap.packages[""].dependencies.zod = "file:../zod";
    await writeFile(packagePath, JSON.stringify(invalidManifest));
    await writeFile(shrinkwrapPath, JSON.stringify(invalidShrinkwrap));
    const rejected = spawnSync(
      process.execPath,
      [validatePackedMetadataScript, packagePath, shrinkwrapPath, "@openclaw/codex", "1.2.3"],
      { encoding: "utf8" },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /forbidden local dependency/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("builds and smokes the exact Codex and QMD artifacts inside the runtime image", async () => {
  const dockerfile = await readFile(
    path.join(repositoryRoot, "downstream/Dockerfile.artifact"),
    "utf8",
  );
  const workflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/build-downstream-artifact.yml"),
    "utf8",
  );
  const imageSmoke = await readFile(
    path.join(repositoryRoot, "downstream/scripts/smoke-image-runtime.mjs"),
    "utf8",
  );
  assert.match(dockerfile, /ARG CODEX_TARBALL_SHA256/u);
  assert.match(dockerfile, /COPY codex-current\.tgz/u);
  assert.match(dockerfile, /CODEX_TARBALL_SHA256.*sha256sum/u);
  assert.match(dockerfile, /ARG QMD_TARBALL_SHA256/u);
  assert.match(dockerfile, /COPY qmd-current\.tgz/u);
  assert.match(dockerfile, /QMD_TARBALL_SHA256.*sha256sum/u);
  assert.match(dockerfile, /npm install --prefix \/opt\/qmd-runtime/u);
  assert.match(
    dockerfile,
    /npm rebuild --prefix \/opt\/qmd-runtime\/node_modules\/@tobilu\/qmd better-sqlite3/u,
  );
  assert.match(dockerfile, /\/opt\/qmd-runtime\/node_modules\/\.bin\/qmd/u);
  assert.match(dockerfile, /--install-strategy=nested/u);
  assert.match(dockerfile, /@openai\/codex.*0\.144\.3/u);
  assert.match(dockerfile, /\/opt\/openclaw-plugin-runtime/u);
  assert.match(dockerfile, /python3-requests/u);
  assert.match(dockerfile, /chromium/u);
  assert.match(dockerfile, /npm install --global npm@12\.0\.1/u);
  assert.match(dockerfile, /npm\/node_modules\/tar\/package\.json/u);
  assert.match(
    dockerfile,
    /ln -s \/app\/node_modules\/openclaw \/opt\/openclaw-plugin-runtime\/node_modules\/@openclaw\/codex\/node_modules\/openclaw/u,
  );
  assert.match(workflow, /CODEX_TARBALL_SHA256=.*codex_artifact_sha256/u);
  assert.match(workflow, /QMD_TARBALL_SHA256=.*qmd_artifact_sha256/u);
  assert.match(workflow, /validate-packed-metadata\.mjs[\s\S]*openclaw[\s\S]*\$VERSION/u);
  assert.match(
    workflow,
    /validate-packed-metadata\.mjs[\s\S]*@openclaw\/codex[\s\S]*\$CODEX_VERSION/u,
  );
  assert.match(workflow, /validate-packed-metadata\.mjs[\s\S]*@tobilu\/qmd[\s\S]*\$QMD_VERSION/u);
  assert.match(workflow, /smoke-image-runtime\.mjs/u);
  assert.match(workflow, /docker run --rm[\s\S]*--network none/u);
  assert.doesNotMatch(workflow, /name: Smoke-test local image\n\s+if:/u);
  assert.match(imageSmoke, /cp\(imagePluginRuntimeRoot, managedPluginRuntimeRoot/u);
  assert.match(imageSmoke, /path\.join\(managedPluginPath, "node_modules\/openclaw"\)/u);
  assert.match(imageSmoke, /spawnSync\("qmd", \["status"\]/u);
  assert.match(imageSmoke, /lstat\(managedHostPeerPath\)/u);
  assert.match(imageSmoke, /python3["], \["-c", "import requests"\]/u);
  assert.match(imageSmoke, /npm["], \["--version"\]/u);
  assert.match(imageSmoke, /npm\/node_modules\/tar\/package\.json/u);
  assert.match(imageSmoke, /chromium["], \["--version"\]/u);
  assert.match(imageSmoke, /--dump-dom/u);
  assert.match(imageSmoke, /OpenClawBrowserSmoke/u);
  assert.doesNotMatch(imageSmoke, /load:\s*\{ paths:/u);
  assert.match(imageSmoke, /rootDir !== managedPluginPath/u);
  assert.match(imageSmoke, /attempt < 120/u);
  assert.match(imageSmoke, /EXPECTED_QMD_VERSION/u);
  assert.match(imageSmoke, /qmd["], \["--version"\]/u);
});

test("rejects a candidate before build without affected clean-install proofs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openclaw-release-evidence-test-"));
  try {
    const manifest = JSON.parse(
      await readFile(
        path.join(repositoryRoot, "downstream/releases/2026.7.1-2-nas.4.json"),
        "utf8",
      ),
    );
    manifest.status = "candidate";
    delete manifest.blockingIssues;
    delete manifest.artifact.validation.dependencyInstallProofs;
    const candidate = path.join(directory, "candidate.json");
    await writeFile(candidate, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [validateScript, candidate], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /affected clean-install proofs before build/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps the latest pointer aligned with the selected manifest", async () => {
  const pointer = JSON.parse(
    await readFile(path.join(repositoryRoot, "downstream/releases/latest.json"), "utf8"),
  );
  assert.match(pointer.releaseManifest, /^downstream\/releases\/[0-9A-Za-z._+-]+\.json$/u);
  assert.equal(pointer.releaseManifest, "downstream/releases/2026.7.1-2-nas.7.json");
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, pointer.releaseManifest), "utf8"),
  );
  assert.equal(pointer.status, manifest.status);
  assert.equal(manifest.status, "qualified");
  assert.equal(manifest.artifact.validation.externalPluginRegistration, true);
  assert.equal(manifest.artifact.validation.scopedLoopbackRpc, true);
  assert.equal(manifest.artifact.validation.dependencyMetadataCheck, true);
  assert.equal(manifest.artifact.validation.dependencyInstallProofs, true);
  assert.equal(manifest.artifact.validation.qmdRuntime, true);
  assert.deepEqual(manifest.runtimeTools, [
    {
      id: "qmd",
      package: "@tobilu/qmd",
      version: "2.1.0",
      integrity:
        "sha512-oOuCoiWL9R2urgj0C336Qpv8qpq1SHhx80Vg5cQo+QRB26XPXqy7MTg/CWS6WAe6ruvVul7kEv21M5YhRzreAw==",
      tarball: "https://registry.npmjs.org/@tobilu/qmd/-/qmd-2.1.0.tgz",
      artifact: {
        filename: "openclaw-qmd-2.1.0-nas.6.tgz",
        url: "https://github.com/AshleyHollis/openclaw/releases/download/nas-v2026.7.1-2.6/openclaw-qmd-2.1.0-nas.6.tgz",
        sha256: "4162fcc8812d44246065d121a339554419b55aeb4358fc61ca4acbda753bf28a",
      },
    },
  ]);
  assert.equal(manifest.artifact.validation.imageSmoke, true);
  assert.equal(manifest.artifact.validation.imageScan, true);
  assert.match(manifest.externalPlugins[0].artifact.url, /nas-v2026\.7\.1-2\.6/u);
  assert.equal(
    manifest.image.digest,
    "sha256:4a10348b997381fc294281375c1f208fbd6208abd7fb6b274053d572c93b8e79",
  );
  assert.equal(
    manifest.image.attestationDigest,
    "sha256:1173f4685910667c5e679dd35d2f717918a5c25d64b7d9292104345b01faf18d",
  );
  assert.equal(
    manifest.image.sbomDigest,
    "sha256:88fe75e5f48d244101dff4250cb0116ba70a8a480240885ac7391211278d95d9",
  );
  assert.equal(
    manifest.image.provenanceDigest,
    "sha256:e9c4fe3a118eec55fd477f1807d7e5f9f247093f72e369ea8ed087a2777dcb4e",
  );
});
