import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { successfulNodeRuntimeProbeResult } from "../../../test/helpers/package-update-steps.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "../../infra/package-dist-inventory.js";

const sharedMocks = vi.hoisted(() => ({
  runCommand: vi.fn(),
  resolveGlobalManager: vi.fn(),
  runUpdateStep: vi.fn(),
}));

vi.mock("./shared.js", () => ({
  createGlobalCommandRunner: () => sharedMocks.runCommand,
  resolveGlobalManager: (...args: unknown[]) => sharedMocks.resolveGlobalManager(...args),
  runUpdateStep: (...args: unknown[]) => sharedMocks.runUpdateStep(...args),
}));

const { runSourceCheckoutGlobalInstall } = await import("./source-checkout-install.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

describe("runSourceCheckoutGlobalInstall", () => {
  let sourceRoot: string;
  let currentPackageRoot: string;
  let pnpmBinDir: string;
  let pnpmGlobalDir: string;
  let pnpmGlobalRoot: string;
  const nodeRunner = "/service/bin/node";

  const restoreRollbackArtifact = async (step: { name: string; argv: string[] }) => {
    if (step.name !== "global update rollback") {
      return false;
    }
    const spec = step.argv.at(-1) ?? "";
    expect(spec).toMatch(/^openclaw@file:/u);
    const artifactPath = spec.slice("openclaw@file:".length);
    const extractDir = tempDirs.make("openclaw-source-rollback-");
    tar.x({ file: artifactPath, cwd: extractDir, sync: true });
    await fs.rm(currentPackageRoot, { recursive: true, force: true });
    await fs.cp(path.join(extractDir, "package"), currentPackageRoot, { recursive: true });
    await fs.writeFile(path.join(pnpmBinDir, "openclaw"), "old shim\n", "utf8");
    return true;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    sourceRoot = tempDirs.make("openclaw-source-install-");
    const managerRoot = tempDirs.make("openclaw-pnpm-manager-");
    pnpmGlobalDir = path.join(managerRoot, "global");
    pnpmGlobalRoot = path.join(pnpmGlobalDir, "5", "node_modules");
    currentPackageRoot = path.join(pnpmGlobalRoot, "openclaw");
    pnpmBinDir = path.join(managerRoot, "bin");
    await fs.mkdir(currentPackageRoot, { recursive: true });
    await fs.mkdir(pnpmBinDir, { recursive: true });
    await fs.writeFile(
      path.join(currentPackageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", bin: { openclaw: "openclaw.mjs" }, version: "1.0.0" }),
      "utf8",
    );
    await fs.writeFile(path.join(pnpmBinDir, "openclaw"), "old shim\n", "utf8");
    await fs.writeFile(
      path.join(sourceRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        bin: { openclaw: "openclaw.mjs" },
        engines: { node: ">=24.15.0 <25" },
      }),
      "utf8",
    );
    sharedMocks.resolveGlobalManager.mockResolvedValue("pnpm");
    sharedMocks.runCommand.mockImplementation(async (argv: string[]) => {
      if (argv[0] === "pnpm" && argv[1] === "root") {
        return { stdout: `${pnpmGlobalRoot}\n`, stderr: "", code: 0 };
      }
      if (argv[0] === "pnpm" && argv[1] === "bin") {
        return { stdout: `${pnpmBinDir}\n`, stderr: "", code: 0 };
      }
      if (argv[0] === nodeRunner && argv[1] === "-e") {
        return successfulNodeRuntimeProbeResult(nodeRunner, "24.15.0");
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });
    sharedMocks.runUpdateStep.mockImplementation(async (step) => {
      await restoreRollbackArtifact(step);
      if (step.name === "global install") {
        await fs.writeFile(
          path.join(currentPackageRoot, "package.json"),
          JSON.stringify({
            name: "openclaw",
            bin: { openclaw: "openclaw.mjs" },
            version: "2.0.0",
          }),
          "utf8",
        );
        await fs.writeFile(path.join(pnpmBinDir, "openclaw"), "new shim\n", "utf8");
      }
      return {
        name: step.name,
        command: step.argv.join(" "),
        cwd: step.cwd,
        durationMs: 1,
        exitCode: 0,
        stdoutTail: "",
        stderrTail: "",
      };
    });
  });

  it("guards pnpm source activation with the managed service Node", async () => {
    const installGuardPath = path.join(sourceRoot, PACKAGE_INSTALL_GUARD_RELATIVE_PATH);
    await fs.mkdir(path.dirname(installGuardPath), { recursive: true });
    await fs.writeFile(installGuardPath, "preinstall incomplete\n", "utf8");

    const result = await runSourceCheckoutGlobalInstall({
      sourceRoot,
      currentPackageRoot,
      installKind: "package",
      nodeRunner,
      env: { PATH: "/usr/bin", PNPM_HOME: path.dirname(pnpmBinDir) },
      timeoutMs: 20_000,
    });

    expect(sharedMocks.runCommand).toHaveBeenCalledWith(
      [nodeRunner, "-e", expect.any(String)],
      expect.objectContaining({
        env: expect.not.objectContaining({ NODE_OPTIONS: expect.anything() }),
        timeoutMs: 10_000,
      }),
    );
    expect(result.steps.map((step) => step.name)).toEqual([
      "global install runtime guard",
      "global install",
      "global install postinstall",
    ]);
    expect(result.failedStep).toBeNull();
    expect(sharedMocks.runUpdateStep).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        argv: ["pnpm", "add", "-g", "--global-dir", pnpmGlobalDir, "--ignore-scripts", sourceRoot],
        env: expect.objectContaining({
          PATH: `${path.dirname(nodeRunner)}${path.delimiter}/usr/bin`,
        }),
      }),
    );
    expect(sharedMocks.runUpdateStep).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        argv: [nodeRunner, path.join(sourceRoot, "scripts/postinstall-bundled-plugins.mjs")],
        cwd: sourceRoot,
      }),
    );
    await expect(fs.access(installGuardPath)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("pins Bun source activation to the resolved global root", async () => {
    const bunInstall = tempDirs.make("openclaw-bun-install-");
    const bunGlobalRoot = path.join(bunInstall, "install", "global", "node_modules");
    currentPackageRoot = path.join(bunGlobalRoot, "openclaw");
    await fs.mkdir(currentPackageRoot, { recursive: true });
    await fs.writeFile(
      path.join(currentPackageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.0.0" }),
      "utf8",
    );
    vi.stubEnv("BUN_INSTALL", bunInstall);
    sharedMocks.resolveGlobalManager.mockResolvedValue("bun");
    sharedMocks.runUpdateStep.mockImplementation(async (step) => {
      await restoreRollbackArtifact(step);
      return {
        name: step.name,
        command: step.argv.join(" "),
        cwd: step.cwd,
        durationMs: 1,
        exitCode: step.name === "global install" ? 1 : 0,
        stdoutTail: "",
        stderrTail: step.name === "global install" ? "install failed" : "",
      };
    });

    const result = await runSourceCheckoutGlobalInstall({
      sourceRoot,
      currentPackageRoot,
      installKind: "package",
      nodeRunner,
      env: { PATH: "/usr/bin" },
      timeoutMs: 20_000,
    });

    expect(result.failedStep?.name).toBe("global install");
    expect(sharedMocks.runUpdateStep).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        argv: ["bun", "add", "-g", "--force", "--ignore-scripts", sourceRoot],
        env: expect.objectContaining({
          BUN_INSTALL_GLOBAL_DIR: path.dirname(bunGlobalRoot),
          PATH: `${path.dirname(nodeRunner)}${path.delimiter}/usr/bin`,
        }),
      }),
    );
    expect(sharedMocks.runUpdateStep).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        name: "global update rollback",
        env: expect.objectContaining({
          BUN_INSTALL_GLOBAL_DIR: path.dirname(bunGlobalRoot),
        }),
      }),
    );
  });

  it.each([
    { exitCode: 1, label: "nonzero", termination: "exit" as const },
    { exitCode: null, label: "timeout", termination: "timeout" as const },
  ])("surfaces a trusted source postinstall $label failure", async ({ exitCode, termination }) => {
    sharedMocks.runUpdateStep.mockImplementation(async (step) => {
      if (step.name === "global install") {
        await fs.writeFile(
          path.join(currentPackageRoot, "package.json"),
          JSON.stringify({
            name: "openclaw",
            bin: { openclaw: "openclaw.mjs" },
            version: "2.0.0",
          }),
          "utf8",
        );
        await fs.writeFile(path.join(pnpmBinDir, "openclaw"), "new shim\n", "utf8");
      } else {
        await restoreRollbackArtifact(step);
      }
      return {
        name: step.name,
        command: step.argv.join(" "),
        cwd: step.cwd,
        durationMs: 1,
        exitCode: step.name === "global install postinstall" ? exitCode : 0,
        stdoutTail: "",
        stderrTail: step.name === "global install postinstall" ? "postinstall failed" : "",
        termination: step.name === "global install postinstall" ? termination : "exit",
      };
    });

    const result = await runSourceCheckoutGlobalInstall({
      sourceRoot,
      currentPackageRoot,
      installKind: "package",
      nodeRunner,
      env: { PATH: "/usr/bin", PNPM_HOME: path.dirname(pnpmBinDir) },
      timeoutMs: 20_000,
    });

    expect(result.failedStep).toMatchObject({
      name: "global install postinstall",
      exitCode,
      stderrTail: "postinstall failed",
      termination,
    });
    expect(result.steps.at(-1)?.name).toBe("global update rollback");
    await expect(
      fs.readFile(path.join(currentPackageRoot, "package.json"), "utf8"),
    ).resolves.toContain('"version":"1.0.0"');
    await expect(fs.readFile(path.join(pnpmBinDir, "openclaw"), "utf8")).resolves.toBe(
      "old shim\n",
    );
  });

  it("rolls back a signal-terminated source activation without running postinstall", async () => {
    sharedMocks.runUpdateStep.mockImplementation(async (step) => {
      if (step.name === "global install") {
        await fs.writeFile(
          path.join(currentPackageRoot, "package.json"),
          JSON.stringify({
            name: "openclaw",
            bin: { openclaw: "openclaw.mjs" },
            version: "2.0.0",
          }),
          "utf8",
        );
        await fs.writeFile(path.join(pnpmBinDir, "openclaw"), "partial shim\n", "utf8");
      } else if (!(await restoreRollbackArtifact(step))) {
        throw new Error(`unexpected step ${step.name}`);
      }
      return {
        name: step.name,
        command: step.argv.join(" "),
        cwd: step.cwd,
        durationMs: 1,
        exitCode: step.name === "global install" ? null : 0,
        stdoutTail: "",
        stderrTail: step.name === "global install" ? "terminated" : "",
        signal: step.name === "global install" ? ("SIGTERM" as const) : null,
        termination: step.name === "global install" ? ("signal" as const) : ("exit" as const),
      };
    });

    const result = await runSourceCheckoutGlobalInstall({
      sourceRoot,
      currentPackageRoot,
      installKind: "package",
      nodeRunner,
      env: { PATH: "/usr/bin", PNPM_HOME: path.dirname(pnpmBinDir) },
      timeoutMs: 20_000,
    });

    expect(result.failedStep).toMatchObject({
      name: "global install",
      exitCode: null,
      signal: "SIGTERM",
      termination: "signal",
    });
    expect(result.steps.map((step) => step.name)).toEqual([
      "global install runtime guard",
      "global install",
      "global update rollback",
    ]);
    expect(sharedMocks.runUpdateStep).toHaveBeenCalledTimes(2);
    await expect(
      fs.readFile(path.join(currentPackageRoot, "package.json"), "utf8"),
    ).resolves.toContain('"version":"1.0.0"');
    await expect(fs.readFile(path.join(pnpmBinDir, "openclaw"), "utf8")).resolves.toBe(
      "old shim\n",
    );
  });

  it("blocks pnpm source activation when the managed service Node is incompatible", async () => {
    sharedMocks.runCommand.mockImplementation(async (argv: string[]) => {
      if (argv[0] === "pnpm" && argv[1] === "root") {
        return { stdout: `${pnpmGlobalRoot}\n`, stderr: "", code: 0 };
      }
      if (argv[0] === nodeRunner && argv[1] === "-e") {
        return successfulNodeRuntimeProbeResult(nodeRunner, "24.14.0");
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    const result = await runSourceCheckoutGlobalInstall({
      sourceRoot,
      currentPackageRoot,
      installKind: "package",
      nodeRunner,
      env: { PATH: "/usr/bin", PNPM_HOME: path.dirname(pnpmBinDir) },
      timeoutMs: 20_000,
    });

    expect(result.failedStep?.name).toBe("global install runtime guard");
    expect(result.failedStep?.stderrTail).toContain(
      "requires Node >=24.15.0 <25; detected Node 24.14.0",
    );
    expect(sharedMocks.runUpdateStep).not.toHaveBeenCalled();
  });
});
