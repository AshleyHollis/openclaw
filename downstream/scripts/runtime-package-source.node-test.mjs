// Node owns this Linux CLI regression; no dependency install or full build is needed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("ref packaging runs the frozen source's package owner, not the publisher's", {
  skip: process.platform === "win32",
}, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "runtime-package-owner-")));
  const source = path.join(root, "source");
  const tooling = path.join(root, "tooling");
  const bin = path.join(root, "bin");
  const temporary = path.join(root, "temporary");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const initialize = async (directory) => {
    await mkdir(directory, { recursive: true });
    git(directory, "init", "-b", "main");
    git(directory, "config", "user.name", "Package fixture");
    git(directory, "config", "user.email", "fixture@example.invalid");
  };
  try {
    await initialize(source);
    await mkdir(path.join(source, "scripts"));
    await writeFile(path.join(source, "package.json"), '{"name":"openclaw","version":"2026.9.2"}\n');
    // Fail deliberately at this boundary: reaching the selected owner is the
    // regression signal, not proof of artifact validation or release readiness.
    await writeFile(path.join(source, "scripts/package-openclaw-for-docker.mjs"),
      'throw new Error("FROZEN_SOURCE_PACKAGE_OWNER_REACHED");\n');
    git(source, "add", ".");
    git(source, "commit", "-m", "frozen runtime");
    const selectedSha = git(source, "rev-parse", "HEAD");

    await initialize(tooling);
    for (const relative of ["scripts/resolve-openclaw-package-candidate.mjs", "scripts/npm-runner.mjs",
      "scripts/windows-cmd-helpers.mjs", "scripts/lib/windows-taskkill.mjs"]) {
      await mkdir(path.dirname(path.join(tooling, relative)), { recursive: true });
      await copyFile(path.join(repository, relative), path.join(tooling, relative));
    }
    await writeFile(path.join(tooling, "scripts/package-openclaw-for-docker.mjs"),
      'throw new Error("WRONG_PUBLISHER_PACKAGE_OWNER");\n');
    git(tooling, "add", ".");
    git(tooling, "commit", "-m", "publisher tooling");
    git(tooling, "remote", "add", "origin", source);
    await mkdir(bin);
    await mkdir(temporary);
    // Dependency installation is a system boundary unrelated to owner choice.
    await writeFile(path.join(bin, "pnpm"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(bin, "pnpm"), 0o755);
    const result = spawnSync(process.execPath, ["scripts/resolve-openclaw-package-candidate.mjs",
      "--source", "ref", "--package-ref", selectedSha, "--output-dir", path.join(root, "output")], {
      cwd: tooling, env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: temporary },
      encoding: "utf8", timeout: 20_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /FROZEN_SOURCE_PACKAGE_OWNER_REACHED/);
    assert.doesNotMatch(result.stderr, /WRONG_PUBLISHER_PACKAGE_OWNER/);
    assert.equal(git(tooling, "worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
