import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  discardLivePackageRollback,
  finalizeLivePackageRollback,
  prepareLivePackageRollback,
  restoreLivePackageRollback,
  stageLivePackageArtifact,
  throwAfterLivePackageRollback,
} from "./package-update-live-activation.js";

async function writePackage(packageRoot: string, version: string, cli: string): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "scripts"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version,
      scripts: { postinstall: "node scripts/postinstall-bundled-plugins.mjs" },
    }),
    "utf8",
  );
  await fs.writeFile(path.join(packageRoot, "openclaw.mjs"), cli, "utf8");
  await fs.writeFile(
    path.join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs"),
    "// postinstall\n",
    "utf8",
  );
}

describe("live package activation rollback", () => {
  it("serializes activation attempts that share package-manager state", async () => {
    await withTempDir({ prefix: "openclaw-live-activation-lock-" }, async (base) => {
      const globalRoot = path.join(base, "global", "11", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackage(packageRoot, "1.0.0", "old cli\n");
      const params = {
        installTarget: {
          manager: "pnpm" as const,
          command: "pnpm",
          globalRoot,
          packageRoot,
        },
        packageName: "openclaw",
        runStep: vi.fn(),
        timeoutMs: 20_000,
        nodePath: process.execPath,
      };

      const first = await prepareLivePackageRollback(params);
      expect(first.failedStep).toBeNull();
      const blocked = await prepareLivePackageRollback(params);
      expect(blocked.rollback).toBeNull();
      expect(blocked.failedStep?.stderrTail).toContain("another OpenClaw package activation");

      await discardLivePackageRollback(first.rollback);
      const next = await prepareLivePackageRollback(params);
      expect(next.failedStep).toBeNull();
      await discardLivePackageRollback(next.rollback);
    });
  });

  it("uses the package manager to restore OpenClaw without replacing concurrent global state", async () => {
    await withTempDir({ prefix: "openclaw-live-activation-" }, async (base) => {
      const stateRoot = path.join(base, "global");
      const globalRoot = path.join(stateRoot, "11", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const binPath = path.join(base, "bin", "openclaw");
      const unrelatedState = path.join(stateRoot, "unrelated-package.json");
      const candidateTarball = path.join(base, "candidate.tgz");
      await writePackage(packageRoot, "1.0.0", "old cli\n");
      await fs.mkdir(path.dirname(binPath), { recursive: true });
      await fs.writeFile(binPath, "old shim\n", "utf8");
      await fs.writeFile(unrelatedState, "before\n", "utf8");
      await fs.writeFile(candidateTarball, "candidate artifact\n", "utf8");

      let rollbackArtifact = "";
      const runStep = vi.fn(async (step) => {
        if (step.name === "global update rollback") {
          const spec = step.argv.at(-1) ?? "";
          expect(spec).toMatch(/^openclaw@file:/u);
          rollbackArtifact = spec.slice("openclaw@file:".length);
          const extractDir = path.join(base, "rollback-extract");
          await fs.mkdir(extractDir);
          tar.x({ file: rollbackArtifact, cwd: extractDir, sync: true });
          await fs.rm(packageRoot, { recursive: true, force: true });
          await fs.cp(path.join(extractDir, "package"), packageRoot, { recursive: true });
          await fs.writeFile(binPath, "old shim\n", "utf8");
        }
        return {
          name: step.name,
          command: step.argv.join(" "),
          cwd: step.cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });
      const prepared = await prepareLivePackageRollback({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          globalRoot,
          packageRoot,
        },
        packageName: "openclaw",
        runStep,
        timeoutMs: 20_000,
        nodePath: process.execPath,
      });
      expect(prepared.failedStep).toBeNull();
      const stagedArtifact = await stageLivePackageArtifact(prepared.rollback, candidateTarball);
      const concurrentArtifact = path.join(
        prepared.rollback!.artifactDir,
        "candidate-concurrent.tgz",
      );
      await fs.writeFile(concurrentArtifact, "other update\n", "utf8");

      await writePackage(packageRoot, "2.0.0", "candidate cli\n");
      await fs.writeFile(binPath, "candidate shim\n", "utf8");
      await fs.writeFile(unrelatedState, "concurrent install\n", "utf8");

      const restored = await restoreLivePackageRollback(prepared.rollback);

      expect(restored?.exitCode).toBe(0);
      expect(runStep.mock.calls.map(([step]) => step.name)).toEqual([
        "global update rollback",
        "global update rollback postinstall",
      ]);
      await expect(fs.readFile(path.join(packageRoot, "openclaw.mjs"), "utf8")).resolves.toBe(
        "old cli\n",
      );
      await expect(fs.readFile(binPath, "utf8")).resolves.toBe("old shim\n");
      await expect(fs.readFile(unrelatedState, "utf8")).resolves.toBe("concurrent install\n");
      await expect(fs.access(rollbackArtifact)).resolves.toBeUndefined();
      await expect(fs.access(stagedArtifact)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(concurrentArtifact, "utf8")).resolves.toBe("other update\n");
    });
  });

  it("surfaces signal-terminated manager rollback as the blocking failure", async () => {
    const packageRoot = path.join(process.cwd(), "tmp-global", "1", "node_modules", "openclaw");
    const rollbackArtifactPath = path.join(process.cwd(), "tmp-rollback.tgz");
    const rollbackStep = {
      name: "global update rollback",
      command: "bun add -g --force rollback.tgz",
      cwd: process.cwd(),
      durationMs: 1,
      exitCode: null,
      stderrTail: "terminated",
      signal: "SIGTERM" as const,
      termination: "signal" as const,
    };
    const failedStep = { ...rollbackStep, name: "global update", exitCode: 1 };
    const rollback = {
      active: true,
      artifactDir: path.dirname(rollbackArtifactPath),
      candidateArtifactPaths: [],
      installTarget: {
        manager: "bun" as const,
        command: "bun",
        globalRoot: path.dirname(packageRoot),
        packageRoot,
      },
      nodePath: process.execPath,
      packageName: "openclaw",
      packageRoot,
      previousArtifactPath: rollbackArtifactPath,
      previousPostinstall: false,
      previousVersion: "1.0.0",
      releaseLock: vi.fn(async () => undefined),
      runStep: vi.fn(async (step) => {
        expect(step.argv).toContain("--force");
        return rollbackStep;
      }),
      timeoutMs: 20_000,
    };
    const throwingRollback = {
      ...rollback,
      releaseLock: vi.fn(async () => undefined),
      runStep: vi.fn(async () => rollbackStep),
    };

    const finalized = await finalizeLivePackageRollback(rollback, failedStep);

    expect(finalized.rollbackStep).toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      termination: "signal",
    });
    expect(finalized.failedStep).toBe(finalized.rollbackStep);
    expect(finalized.failedStep?.stderrTail).toContain("rollback artifact preserved");
    await expect(
      throwAfterLivePackageRollback(throwingRollback, new Error("update failed")),
    ).rejects.toBeInstanceOf(AggregateError);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a package-manager state symlink whose canonical target is the filesystem root",
    async () => {
      await withTempDir({ prefix: "openclaw-live-activation-root-" }, async (base) => {
        const stateRoot = path.join(base, "global");
        await fs.symlink(path.parse(base).root, stateRoot, "junction");
        const globalRoot = path.join(stateRoot, "node_modules");
        const prepared = await prepareLivePackageRollback({
          installTarget: {
            manager: "bun",
            command: "bun",
            globalRoot,
            packageRoot: path.join(globalRoot, "openclaw"),
          },
          packageName: "openclaw",
          runStep: vi.fn(),
          timeoutMs: 20_000,
          nodePath: process.execPath,
        });

        expect(prepared.rollback).toBeNull();
        expect(prepared.failedStep?.stderrTail).toContain("filesystem root");
      });
    },
  );
});
