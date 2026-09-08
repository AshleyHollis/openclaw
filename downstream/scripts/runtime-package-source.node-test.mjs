// Node owns this Linux CLI regression; no dependency install or full build is needed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

for (const scenario of [
  { name: "ref packaging uses selected package owner", source: "ref", packageFailure: true },
  { name: "ref validates with selected owner before cleanup", source: "ref" },
  {
    name: "ref validation failure refuses receipt and cleans up",
    source: "ref",
    validationFailure: true,
  },
  { name: "ref hash mismatch refuses validation and receipt", source: "ref", hashFailure: true },
  { name: "artifact keeps publisher validation", source: "artifact" },
  {
    name: "artifact publisher rejection refuses receipt",
    source: "artifact",
    validationFailure: true,
  },
])
  test(
    scenario.name,
    {
      skip: process.platform === "win32",
    },
    async () => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "runtime-package-owner-")));
      const source = path.join(root, "source");
      const tooling = path.join(root, "tooling");
      const bin = path.join(root, "bin");
      const temporary = path.join(root, "temporary");
      const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
      const git = (cwd, ...args) =>
        execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
      const initialize = async (directory) => {
        await mkdir(directory, { recursive: true });
        git(directory, "init", "-b", "main");
        git(directory, "config", "user.name", "Package fixture");
        git(directory, "config", "user.email", "fixture@example.invalid");
      };
      try {
        await initialize(source);
        await mkdir(path.join(source, "scripts"));
        await writeFile(
          path.join(source, "package.json"),
          '{"name":"openclaw","version":"2026.9.2"}\n',
        );
        const input = path.join(root, "input");
        await mkdir(path.join(input, "package"), { recursive: true });
        await copyFile(path.join(source, "package.json"), path.join(input, "package/package.json"));
        const archive = path.join(input, "candidate.tgz");
        execFileSync("tar", ["-czf", archive, "package"], { cwd: input });
        const digest = createHash("sha256")
          .update(await readFile(archive))
          .digest("hex");
        // Synthetic owners expose the real resolver's invocation/lifetime contract;
        // they do not substitute for the selected runtime's full archive proof.
        await writeFile(
          path.join(source, "scripts/package-openclaw-for-docker.mjs"),
          scenario.packageFailure
            ? 'throw new Error("FROZEN_SOURCE_PACKAGE_OWNER_REACHED");\n'
            : `import { copyFileSync } from "node:fs";
           import path from "node:path";
           copyFileSync(${JSON.stringify(archive)}, path.join(process.argv[process.argv.indexOf("--output-dir") + 1], "openclaw-current.tgz"));\n`,
        );
        const validator = (owner) => `import { execFileSync } from "node:child_process";
      import { fileURLToPath } from "node:url";
      import path from "node:path";
      if (process.cwd() !== path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) throw new Error("WRONG_VALIDATION_CWD");
      const pkg = JSON.parse(execFileSync("tar", ["-xOzf", process.argv[2], "package/package.json"], { encoding: "utf8" }));
      if (pkg.name !== "openclaw") throw new Error("WRONG_ARCHIVE");
      console.error("${owner}_VALIDATION_REACHED");
      ${scenario.validationFailure ? 'throw new Error("VALIDATION_REJECTED");' : ""}\n`;
        await writeFile(
          path.join(source, "scripts/check-openclaw-package-tarball.mjs"),
          validator("SOURCE"),
        );
        git(source, "add", ".");
        git(source, "commit", "-m", "frozen runtime");
        const selectedSha = git(source, "rev-parse", "HEAD");

        await initialize(tooling);
        for (const relative of [
          "scripts/resolve-openclaw-package-candidate.mjs",
          "scripts/npm-runner.mjs",
          "scripts/windows-cmd-helpers.mjs",
          "scripts/lib/windows-taskkill.mjs",
        ]) {
          await mkdir(path.dirname(path.join(tooling, relative)), { recursive: true });
          await copyFile(path.join(repository, relative), path.join(tooling, relative));
        }
        await writeFile(
          path.join(tooling, "scripts/package-openclaw-for-docker.mjs"),
          'throw new Error("WRONG_PUBLISHER_PACKAGE_OWNER");\n',
        );
        await writeFile(
          path.join(tooling, "scripts/check-openclaw-package-tarball.mjs"),
          scenario.source === "ref"
            ? 'throw new Error("WRONG_PUBLISHER_VALIDATOR");\n'
            : validator("PUBLISHER"),
        );
        git(tooling, "add", ".");
        git(tooling, "commit", "-m", "publisher tooling");
        git(tooling, "remote", "add", "origin", source);
        await mkdir(bin);
        await mkdir(temporary);
        // Dependency installation is a system boundary unrelated to owner choice.
        await writeFile(path.join(bin, "pnpm"), "#!/bin/sh\nexit 0\n");
        await chmod(path.join(bin, "pnpm"), 0o755);
        const metadata = path.join(root, "output/receipt.json");
        const result = spawnSync(
          process.execPath,
          [
            "scripts/resolve-openclaw-package-candidate.mjs",
            "--source",
            scenario.source,
            "--package-ref",
            selectedSha,
            "--artifact-dir",
            input,
            "--output-dir",
            path.join(root, "output"),
            "--metadata",
            metadata,
            ...(scenario.hashFailure ? ["--package-sha256", "0".repeat(64)] : []),
          ],
          {
            cwd: tooling,
            env: {
              ...env,
              PATH: `${bin}${path.delimiter}${process.env.PATH}`,
              RUNNER_TEMP: temporary,
            },
            encoding: "utf8",
            timeout: 20_000,
          },
        );
        const failed =
          scenario.packageFailure || scenario.validationFailure || scenario.hashFailure;
        assert.equal(result.status, failed ? 1 : 0, result.stderr);
        if (scenario.packageFailure)
          assert.match(result.stderr, /FROZEN_SOURCE_PACKAGE_OWNER_REACHED/);
        else if (scenario.hashFailure) assert.doesNotMatch(result.stderr, /VALIDATION_REACHED/);
        else
          assert.match(
            result.stderr,
            new RegExp(`${scenario.source === "ref" ? "SOURCE" : "PUBLISHER"}_VALIDATION_REACHED`),
          );
        if (scenario.validationFailure) assert.match(result.stderr, /VALIDATION_REJECTED/);
        if (failed) await assert.rejects(readFile(metadata), { code: "ENOENT" });
        else {
          const receipt = JSON.parse(await readFile(metadata, "utf8"));
          assert.equal(receipt.sha256, digest);
          assert.equal(receipt.version, "2026.9.2");
          if (scenario.source === "ref") assert.equal(receipt.packageSourceSha, selectedSha);
        }
        assert.doesNotMatch(result.stderr, /WRONG_PUBLISHER_PACKAGE_OWNER/);
        assert.doesNotMatch(result.stderr, /WRONG_PUBLISHER_VALIDATOR/);
        assert.equal(
          git(tooling, "worktree", "list", "--porcelain").split("worktree ").length - 1,
          1,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
