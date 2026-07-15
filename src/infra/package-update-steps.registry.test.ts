import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import {
  TEST_GIT_COMMIT,
  expectPathMissing,
  successfulNodeRuntimeProbeResult,
  successfulPackagePostinstallStep,
  successfulSourceMetadataStep,
  type PackageUpdateStepResult,
  writePackageRoot,
  writePackageTarball,
} from "../../test/helpers/package-update-steps.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "./package-dist-inventory.js";
import { pinGitPackageInstallSpec } from "./package-manager-install-policy.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import type { CommandRunner } from "./update-global.js";

function isolatedPnpmGlobalDir(argv: string[]): string {
  const index = argv.indexOf("--global-dir");
  const globalDir = argv[index + 1];
  if (!globalDir) {
    throw new Error("missing isolated pnpm global directory");
  }
  return globalDir;
}

describe("registry package update steps", () => {
  it("rejects an incompatible pnpm registry target before the live install", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-registry-guard-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm", "v11");
      const packageRoot = path.join(globalRoot, "install", "node_modules", "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "global update registry resolve") {
          throw new Error(`unexpected step ${name}`);
        }
        expect(argv.at(-1)).toBe("openclaw@latest");
        const candidateRoot = path.join(
          isolatedPnpmGlobalDir(argv),
          "v11",
          "install",
          "node_modules",
          "openclaw",
        );
        await writePackageRoot(candidateRoot, "2.0.0", { nodeEngine: ">=24.15.0 <25" });
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });
      const runCommand = vi.fn<CommandRunner>(async (argv) => {
        if (argv[0] === "/service/node" && argv[1] === "-e") {
          return successfulNodeRuntimeProbeResult("/service/node", "24.14.0");
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@latest",
        packageName: "openclaw",
        packageRoot,
        nodePath: "/service/node",
        runCommand,
        runStep,
        timeoutMs: 1000,
        env: { PATH: path.join(base, "manager-bin") },
      });

      expect(result.failedStep).toMatchObject({
        name: "global update registry runtime guard",
        stderrTail: expect.stringContaining("detected Node 24.14.0"),
      });
      expect(result.afterVersion).toBe("1.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update registry resolve",
        "global update registry version guard",
        "global update registry runtime guard",
      ]);
      expect(runStep).toHaveBeenCalledOnce();
    });
  });

  it("uses pnpm 10 itself to resolve a range without requiring npm", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm10-resolve-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm", "5", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "global update registry resolve") {
          throw new Error(`unexpected step ${name}`);
        }
        expect(argv[0]).toBe("pnpm");
        expect(argv).toContain("--ignore-scripts");
        expect(argv.at(-1)).toBe("openclaw@^2");
        const candidateRoot = path.join(
          isolatedPnpmGlobalDir(argv),
          "5",
          "node_modules",
          "openclaw",
        );
        await writePackageRoot(candidateRoot, "2.1.0", { nodeEngine: ">=999.0.0" });
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });
      const runCommand = vi.fn<CommandRunner>(async (argv) => {
        if (argv[0] === "/service/node" && argv[1] === "-e") {
          return successfulNodeRuntimeProbeResult("/service/node", "24.15.0");
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@^2",
        packageName: "openclaw",
        packageRoot,
        nodePath: "/service/node",
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toMatchObject({
        name: "global update registry runtime guard",
        stderrTail: expect.stringContaining("requires Node >=999.0.0"),
      });
      expect(result.afterVersion).toBe("1.0.0");
      expect(runStep).toHaveBeenCalledOnce();
      expect(runCommand).toHaveBeenCalledOnce();
    });
  });

  it("pins Bun's isolated resolution without npm and runs only the validated lifecycle", async () => {
    await withTempDir({ prefix: "openclaw-package-update-bun-registry-" }, async (base) => {
      const globalRoot = path.join(base, "bun", "install", "global", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const binDir = path.join(base, "bun", "bin");
      const artifactDir = path.join(path.dirname(globalRoot), ".openclaw-update-artifacts");
      const existingArtifact = path.join(artifactDir, "existing.tgz");
      let persistentArtifact: string | null = null;
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.writeFile(existingArtifact, "other update\n", "utf8");
      const runStep = vi.fn(async ({ name, argv, cwd, env }): Promise<PackageUpdateStepResult> => {
        const pathEntries = (env?.PATH ?? "").split(path.delimiter);
        if (name === "global update registry resolve") {
          expect(pathEntries[1]).toBe("/service");
          expect(argv).toEqual(["bun", "add", "-g", "--ignore-scripts", "openclaw@latest"]);
          const candidateGlobalDir = env?.BUN_INSTALL_GLOBAL_DIR;
          expect(candidateGlobalDir).not.toBe(path.dirname(globalRoot));
          if (!candidateGlobalDir) {
            throw new Error("missing isolated Bun global directory");
          }
          await expect(
            fs.readFile(path.join(candidateGlobalDir, "package.json"), "utf8"),
          ).resolves.toBe('{"private":true}\n');
          const candidateRoot = path.join(candidateGlobalDir, "node_modules", "openclaw");
          await writePackageRoot(candidateRoot, "2.0.0", {
            nodeEngine: ">=24.15.0 <25",
          });
          await fs.writeFile(
            path.join(candidateRoot, "registry-marker.txt"),
            "bun registry artifact\n",
            "utf8",
          );
        } else if (name === "global update") {
          expect(pathEntries[0]).toBe("/service");
          expect(env?.BUN_INSTALL_GLOBAL_DIR).toBe(path.dirname(globalRoot));
          expect(argv.slice(0, -1)).toEqual(["bun", "add", "-g", "--force", "--ignore-scripts"]);
          const artifactSpec = argv.at(-1) ?? "";
          expect(artifactSpec).toMatch(/^openclaw@file:/u);
          const artifactPath = artifactSpec.slice("openclaw@file:".length);
          expect(path.dirname(artifactPath)).toBe(artifactDir);
          persistentArtifact = artifactPath;
          const extractDir = path.join(base, "selected-bun-artifact");
          await fs.mkdir(extractDir);
          tar.x({ file: artifactPath, cwd: extractDir, sync: true });
          await expect(
            fs.readFile(path.join(extractDir, "package", "registry-marker.txt"), "utf8"),
          ).resolves.toBe("bun registry artifact\n");
          await writePackageRoot(packageRoot, "2.0.0", {
            installGuard: true,
            nodeEngine: ">=24.15.0 <25",
          });
        } else if (name === "global install postinstall") {
          expect(pathEntries[0]).toBe("/service");
          expect(cwd).toBe(packageRoot);
          expect(argv[1]).toBe(
            path.join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs"),
          );
        } else {
          throw new Error(`unexpected step ${name}`);
        }
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });
      const runCommand = vi.fn<CommandRunner>(async (argv) => {
        if (argv[0] === "/service/node" && argv[1] === "-e") {
          return successfulNodeRuntimeProbeResult("/service/node", "24.15.0");
        }
        if (argv.join(" ") === "bun pm bin -g") {
          return { stdout: `${binDir}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "bun",
          command: "bun",
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@latest",
        packageName: "openclaw",
        packageRoot,
        nodePath: "/service/node",
        runCommand,
        runStep,
        timeoutMs: 1000,
        env: { PATH: path.join(base, "manager-bin") },
      });

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update registry resolve",
        "global update registry version guard",
        "global update registry runtime guard",
        "global update registry artifact",
        "global update pack runtime guard",
        "global update",
        "global install runtime guard",
        "global install postinstall",
      ]);
      await expectPathMissing(path.join(packageRoot, PACKAGE_INSTALL_GUARD_RELATIVE_PATH));
      expect(persistentArtifact).not.toBeNull();
      await expect(fs.access(persistentArtifact!)).resolves.toBeUndefined();
      await expect(fs.readFile(existingArtifact, "utf8")).resolves.toBe("other update\n");
    });
  });

  it("restores a pnpm symlinked package when live postinstall fails", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-live-rollback-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm", "11", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const binDir = path.join(base, "pnpm", "bin");
      const artifactDir = path.join(base, "pnpm", ".openclaw-update-artifacts");
      const oldStoreRoot = path.join(base, "pnpm", ".pnpm", "openclaw@1", "openclaw");
      const newStoreRoot = path.join(base, "pnpm", ".pnpm", "openclaw@2", "openclaw");
      let persistentArtifact: string | null = null;
      let rollbackArtifact: string | null = null;
      await writePackageRoot(oldStoreRoot, "1.0.0");
      await fs.mkdir(globalRoot, { recursive: true });
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(path.join(binDir, "openclaw"), "old shim\n", "utf8");
      const oldLinkTarget = path.relative(globalRoot, oldStoreRoot);
      await fs.symlink(oldLinkTarget, packageRoot, "junction");

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name === "global update registry resolve") {
          await writePackageRoot(
            path.join(isolatedPnpmGlobalDir(argv), "v11", "node_modules", "openclaw"),
            "2.0.0",
          );
        } else if (name === "global update") {
          const artifactSpec = argv.at(-1) ?? "";
          expect(artifactSpec).toMatch(/^openclaw@file:/u);
          const artifactPath = artifactSpec.slice("openclaw@file:".length);
          persistentArtifact = artifactPath;
          expect(path.dirname(artifactPath)).toBe(artifactDir);
          await fs.rm(packageRoot, { force: true });
          await fs.rm(oldStoreRoot, { recursive: true, force: true });
          await writePackageRoot(newStoreRoot, "2.0.0", { installGuard: true });
          await fs.symlink(path.relative(globalRoot, newStoreRoot), packageRoot, "junction");
          await fs.writeFile(path.join(binDir, "openclaw"), "new shim\n", "utf8");
        } else if (name === "global install postinstall") {
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 1,
            stderrTail: "postinstall failed",
          };
        } else if (name === "global update rollback") {
          const artifactSpec = argv.at(-1) ?? "";
          expect(artifactSpec).toMatch(/^openclaw@file:/u);
          const rollbackPath = artifactSpec.slice("openclaw@file:".length);
          rollbackArtifact = rollbackPath;
          const extractDir = path.join(base, "rollback-package");
          await fs.mkdir(extractDir);
          tar.x({ file: rollbackPath, cwd: extractDir, sync: true });
          await fs.rm(packageRoot, { force: true });
          await fs.rm(newStoreRoot, { recursive: true, force: true });
          await fs.cp(path.join(extractDir, "package"), oldStoreRoot, { recursive: true });
          await fs.symlink(oldLinkTarget, packageRoot, "junction");
          await fs.writeFile(path.join(binDir, "openclaw"), "old shim\n", "utf8");
        } else if (name === "global update rollback postinstall") {
          expect(cwd).toBe(packageRoot);
        } else {
          throw new Error(`unexpected step ${name}`);
        }
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });
      const runCommand = vi.fn<CommandRunner>(async (argv) => {
        if (argv[0] === process.execPath && argv[1] === "-e") {
          return successfulNodeRuntimeProbeResult(process.execPath);
        }
        if (argv.join(" ") === "pnpm bin -g") {
          return { stdout: `${binDir}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: { manager: "pnpm", command: "pnpm", globalRoot, packageRoot },
        installSpec: "openclaw@latest",
        packageName: "openclaw",
        packageRoot,
        nodePath: process.execPath,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toMatchObject({
        name: "global install postinstall",
        stderrTail: "postinstall failed",
      });
      expect(result.afterVersion).toBe("1.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update registry resolve",
        "global update registry version guard",
        "global update registry runtime guard",
        "global update registry artifact",
        "global update pack runtime guard",
        "global update",
        "global install runtime guard",
        "global install postinstall",
        "global update rollback",
      ]);
      expect((await fs.lstat(packageRoot)).isSymbolicLink()).toBe(true);
      await expect(fs.readlink(packageRoot)).resolves.toBe(oldLinkTarget);
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
      await expect(fs.readFile(path.join(binDir, "openclaw"), "utf8")).resolves.toBe("old shim\n");
      expect(persistentArtifact).not.toBeNull();
      await expectPathMissing(persistentArtifact!);
      expect(rollbackArtifact).not.toBeNull();
      await expect(fs.access(rollbackArtifact!)).resolves.toBeUndefined();
    });
  });

  it("rejects an incompatible pnpm tarball before the live install", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-tarball-guard-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm", "global", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const sourceTarball = path.join(base, "openclaw-candidate.tgz");
      await writePackageRoot(packageRoot, "1.0.0");
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "global update pack") {
          throw new Error(`unexpected step ${name}`);
        }
        const packIndex = argv.indexOf("pack");
        expect(argv[packIndex + 1]).toBe(sourceTarball);
        expect(argv).toContain("--ignore-scripts");
        const destination = argv[argv.indexOf("--pack-destination") + 1];
        if (!destination) {
          throw new Error("missing pack destination");
        }
        await writePackageTarball(destination, "2.0.0", { nodeEngine: ">=999.0.0" });
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });
      const runCommand = vi.fn<CommandRunner>(async (argv) => {
        if (argv[0] === process.execPath && argv[1] === "-e") {
          return successfulNodeRuntimeProbeResult(process.execPath);
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          globalRoot,
          packageRoot,
        },
        installSpec: sourceTarball,
        packageName: "openclaw",
        packageRoot,
        nodePath: process.execPath,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toMatchObject({
        name: "global update pack runtime guard",
        stderrTail: expect.stringContaining("requires Node >=999.0.0"),
      });
      expect(result.afterVersion).toBe("1.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update pack",
        "global update pack runtime guard",
      ]);
      expect(runStep).toHaveBeenCalledOnce();
    });
  });

  it("builds and guards a Bun Git source before the live install", async () => {
    await withTempDir({ prefix: "openclaw-package-update-bun-source-" }, async (base) => {
      const globalRoot = path.join(base, "bun", "install", "global", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const binDir = path.join(base, "bun", "bin");
      const sourceSpec = "openclaw/openclaw";
      await writePackageRoot(packageRoot, "1.0.0");
      let packDir: string | undefined;
      let packedTarball: string | undefined;
      let persistentArtifact: string | null = null;
      const runStep = vi.fn(async ({ name, argv, cwd, env }): Promise<PackageUpdateStepResult> => {
        const metadataStep = successfulSourceMetadataStep({
          name,
          argv,
          cwd,
          resolved: `git+https://github.com/openclaw/openclaw.git#${TEST_GIT_COMMIT}`,
        });
        if (metadataStep) {
          return metadataStep;
        }
        if (name === "global update pack") {
          const pinnedSpec = pinGitPackageInstallSpec("openclaw", sourceSpec, TEST_GIT_COMMIT);
          expect(argv[argv.indexOf("pack") + 1]).toBe(pinnedSpec);
          expect(argv).toContain("--ignore-scripts=false");
          expect((env?.PATH ?? "").split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
          packDir = argv[argv.indexOf("--pack-destination") + 1];
          if (!packDir) {
            throw new Error("missing pack destination");
          }
          packedTarball = await writePackageTarball(packDir, "2.0.0");
        } else if (name === "global update") {
          expect(argv.slice(0, -1)).toEqual(["bun", "add", "-g", "--force", "--ignore-scripts"]);
          const artifactSpec = argv.at(-1) ?? "";
          expect(artifactSpec).toMatch(/^openclaw@file:/u);
          const artifactPath = artifactSpec.slice("openclaw@file:".length);
          persistentArtifact = artifactPath;
          expect(path.dirname(artifactPath)).toBe(
            path.join(path.dirname(globalRoot), ".openclaw-update-artifacts"),
          );
          await expect(fs.access(artifactPath)).resolves.toBeUndefined();
          expect(artifactPath).not.toBe(packedTarball);
          expect(env?.BUN_INSTALL_GLOBAL_DIR).toBe(path.dirname(globalRoot));
          await writePackageRoot(packageRoot, "2.0.0", { installGuard: true });
        } else {
          const postinstallStep = successfulPackagePostinstallStep({ name, argv, cwd });
          if (postinstallStep) {
            return postinstallStep;
          }
          throw new Error(`unexpected step ${name}`);
        }
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });
      const runCommand = vi.fn<CommandRunner>(async (argv) => {
        if (argv[0] === process.execPath && argv[1] === "-e") {
          return successfulNodeRuntimeProbeResult(process.execPath);
        }
        if (argv.join(" ") === "bun pm bin -g") {
          return { stdout: `${binDir}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "bun",
          command: "bun",
          globalRoot,
          packageRoot,
        },
        installSpec: sourceSpec,
        packageName: "openclaw",
        packageRoot,
        nodePath: process.execPath,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update source metadata",
        "global update source runtime guard",
        "global update pack",
        "global update pack runtime guard",
        "global update",
        "global install runtime guard",
        "global install postinstall",
      ]);
      if (!packDir) {
        throw new Error("expected pack directory");
      }
      await expectPathMissing(packDir);
      expect(persistentArtifact).not.toBeNull();
      await expect(fs.access(persistentArtifact!)).resolves.toBeUndefined();
    });
  });
});
