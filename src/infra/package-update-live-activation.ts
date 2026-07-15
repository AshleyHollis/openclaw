import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireFileLock } from "../plugin-sdk/file-lock.js";
import { formatErrorMessage } from "./errors.js";
import { archivePackageRootToTarball } from "./package-update-source.js";
import type { PackageUpdateStepResult, PackageUpdateStepRunner } from "./package-update-types.js";
import {
  globalInstallArgs,
  resolvePnpmGlobalDirFromGlobalRoot,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

const LIVE_PACKAGE_ARTIFACT_DIR = ".openclaw-update-artifacts";
const LIVE_PACKAGE_LOCK_TARGET = ".openclaw-update-activation";
const PACKAGE_POSTINSTALL_COMMAND = "node scripts/postinstall-bundled-plugins.mjs";
const PACKAGE_POSTINSTALL_RELATIVE_PATH = "scripts/postinstall-bundled-plugins.mjs";
const ACTIVE_LIVE_PACKAGE_LOCKS = new Set<string>();
const LIVE_PACKAGE_LOCK_OPTIONS = {
  retries: {
    retries: 8,
    factor: 1.5,
    minTimeout: 100,
    maxTimeout: 1_000,
    randomize: true,
  },
  stale: 15 * 60_000,
  staleRecovery: "fail-closed",
} as const;

export type LivePackageRollback = {
  active: boolean;
  artifactDir: string;
  candidateArtifactPaths: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  installTarget: ResolvedGlobalInstallTarget;
  nodePath: string | null;
  packageName: string;
  packageRoot: string;
  previousArtifactPath: string;
  previousPostinstall: boolean;
  previousVersion: string;
  releaseLock: (() => Promise<void>) | null;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
};

export function createPackageManagerInstallEnv(
  target: ResolvedGlobalInstallTarget,
  env: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (target.manager !== "bun" || !target.globalRoot) {
    return env;
  }
  return {
    ...Object.fromEntries(
      Object.entries(env ?? process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    BUN_INSTALL_GLOBAL_DIR: path.dirname(target.globalRoot),
  };
}

function rollbackStep(params: {
  name: string;
  command: string;
  cwd: string;
  startedAt: number;
  error?: unknown;
  stdoutTail?: string;
}): PackageUpdateStepResult {
  return {
    name: params.name,
    command: params.command,
    cwd: params.cwd,
    durationMs: Date.now() - params.startedAt,
    exitCode: params.error === undefined ? 0 : 1,
    stdoutTail: params.error === undefined ? (params.stdoutTail ?? null) : null,
    stderrTail: params.error === undefined ? null : formatErrorMessage(params.error),
  };
}

function resolveManagerStateRoot(target: ResolvedGlobalInstallTarget): string {
  if (target.manager === "pnpm") {
    const globalDir = resolvePnpmGlobalDirFromGlobalRoot(target.globalRoot);
    if (globalDir) {
      return globalDir;
    }
  } else if (
    target.manager === "bun" &&
    path.basename(target.globalRoot ?? "") === "node_modules"
  ) {
    return path.dirname(target.globalRoot!);
  }
  throw new Error(`cannot resolve ${target.manager} global state root for safe live activation`);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveSafeManagerStateRoot(target: ResolvedGlobalInstallTarget): Promise<string> {
  const stateRoot = path.resolve(resolveManagerStateRoot(target));
  const canonicalStateRoot = await fs.realpath(stateRoot);
  if (
    stateRoot === path.parse(stateRoot).root ||
    canonicalStateRoot === path.parse(canonicalStateRoot).root
  ) {
    throw new Error(`refusing to use filesystem root for ${target.manager} package state`);
  }
  if (!(await fs.stat(canonicalStateRoot)).isDirectory()) {
    throw new Error(`package-manager state root is not a directory: ${stateRoot}`);
  }
  const packageRoot = target.packageRoot ? path.resolve(target.packageRoot) : null;
  const canonicalPackageRoot = packageRoot ? await fs.realpath(packageRoot) : null;
  if (
    !packageRoot ||
    !canonicalPackageRoot ||
    (!isPathInside(stateRoot, packageRoot) &&
      !isPathInside(canonicalStateRoot, canonicalPackageRoot))
  ) {
    throw new Error(
      `package root is outside ${target.manager} global state: ${packageRoot ?? "missing"}`,
    );
  }
  return canonicalStateRoot;
}

async function acquireLivePackageLock(stateRoot: string): Promise<() => Promise<void>> {
  const lockTarget = path.join(stateRoot, LIVE_PACKAGE_LOCK_TARGET);
  // The filesystem lock covers other processes. This set blocks re-entrant
  // acquisitions in this process so two updater requests cannot share it.
  if (ACTIVE_LIVE_PACKAGE_LOCKS.has(lockTarget)) {
    throw new Error(`another OpenClaw package activation is already using ${stateRoot}`);
  }
  ACTIVE_LIVE_PACKAGE_LOCKS.add(lockTarget);
  try {
    const lock = await acquireFileLock(lockTarget, LIVE_PACKAGE_LOCK_OPTIONS);
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        await lock.release();
      } finally {
        ACTIVE_LIVE_PACKAGE_LOCKS.delete(lockTarget);
      }
    };
  } catch (error) {
    ACTIVE_LIVE_PACKAGE_LOCKS.delete(lockTarget);
    throw error;
  }
}

async function releaseLivePackageLock(rollback: LivePackageRollback): Promise<void> {
  const releaseLock = rollback.releaseLock;
  rollback.releaseLock = null;
  await releaseLock?.();
}

async function readRollbackContract(packageRoot: string): Promise<{
  previousPostinstall: boolean;
  previousVersion: string;
}> {
  const parsed = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    scripts?: { postinstall?: unknown };
    version?: unknown;
  };
  if (typeof parsed.version !== "string" || !parsed.version.trim()) {
    throw new Error(`installed package has no version: ${packageRoot}`);
  }
  return {
    previousPostinstall: parsed.scripts?.postinstall === PACKAGE_POSTINSTALL_COMMAND,
    previousVersion: parsed.version.trim(),
  };
}

export async function prepareLivePackageRollback(params: {
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  nodePath?: string | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<{
  rollback: LivePackageRollback | null;
  failedStep: PackageUpdateStepResult | null;
}> {
  const startedAt = Date.now();
  let previousArtifactPath: string | null = null;
  let releaseLock: (() => Promise<void>) | null = null;
  try {
    const packageRoot = params.installTarget.packageRoot;
    if (!packageRoot) {
      throw new Error(`cannot resolve installed ${params.packageName} package root`);
    }
    const stateRoot = await resolveSafeManagerStateRoot(params.installTarget);
    releaseLock = await acquireLivePackageLock(stateRoot);
    const artifactDir = path.join(stateRoot, LIVE_PACKAGE_ARTIFACT_DIR);
    await fs.mkdir(artifactDir, { recursive: true });
    previousArtifactPath = path.join(artifactDir, `rollback-${randomUUID()}.tgz`);
    const contract = await readRollbackContract(packageRoot);
    const nodePath =
      params.nodePath?.trim() || (process.versions.bun ? null : process.execPath || null);
    if (contract.previousPostinstall && !nodePath) {
      throw new Error("cannot resolve Node for rollback package postinstall");
    }
    await archivePackageRootToTarball(packageRoot, previousArtifactPath);
    return {
      rollback: {
        active: true,
        artifactDir,
        candidateArtifactPaths: [],
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        ...(params.env === undefined ? {} : { env: { ...params.env } }),
        installTarget: params.installTarget,
        nodePath,
        packageName: params.packageName,
        packageRoot,
        previousArtifactPath,
        previousPostinstall: contract.previousPostinstall,
        previousVersion: contract.previousVersion,
        releaseLock,
        runStep: params.runStep,
        timeoutMs: params.timeoutMs,
      },
      failedStep: null,
    };
  } catch (error) {
    let failure = error;
    if (previousArtifactPath) {
      await fs.rm(previousArtifactPath, { force: true }).catch(() => undefined);
    }
    if (releaseLock) {
      try {
        await releaseLock();
      } catch (releaseError) {
        failure = new AggregateError(
          [error, releaseError],
          "package activation lock release failed",
        );
      }
    }
    return {
      rollback: null,
      failedStep: rollbackStep({
        name: "global update rollback prepare",
        command: `archive current ${params.packageName} package`,
        cwd: params.cwd ?? params.installTarget.packageRoot ?? process.cwd(),
        startedAt,
        error: failure,
      }),
    };
  }
}

/** Keeps a packed candidate at the stable path pnpm and Bun persist in manager state. */
export async function stageLivePackageArtifact(
  rollback: LivePackageRollback | null,
  sourceTarball: string,
): Promise<string> {
  if (!rollback?.active) {
    throw new Error("cannot stage a live package artifact without an active rollback artifact");
  }
  const artifactPath = path.join(rollback.artifactDir, `candidate-${randomUUID()}.tgz`);
  await fs.copyFile(sourceTarball, artifactPath);
  rollback.candidateArtifactPaths.push(artifactPath);
  return artifactPath;
}

async function discardCandidateArtifactsBestEffort(rollback: LivePackageRollback): Promise<void> {
  const artifactPaths = rollback.candidateArtifactPaths.splice(0);
  await Promise.all(
    artifactPaths.map((artifactPath) => fs.rm(artifactPath, { force: true })),
  ).catch(() => undefined);
}

function preserveArtifactFailure(
  rollback: LivePackageRollback,
  step: PackageUpdateStepResult,
): PackageUpdateStepResult {
  const detail = `rollback artifact preserved at ${rollback.previousArtifactPath}`;
  return {
    ...step,
    stderrTail: [step.stderrTail, detail].filter(Boolean).join("\n"),
  };
}

async function completeSuccessfulRollback(params: {
  rollback: LivePackageRollback;
  installStep: PackageUpdateStepResult;
  startedAt: number;
}): Promise<PackageUpdateStepResult> {
  const restoredContract = await readRollbackContract(params.rollback.packageRoot);
  if (restoredContract.previousVersion !== params.rollback.previousVersion) {
    throw new Error(
      `rollback restored ${restoredContract.previousVersion}, expected ${params.rollback.previousVersion}`,
    );
  }
  // Only this attempt's candidate is safe to remove. Unknown files may
  // predate this transaction and must remain untouched.
  await discardCandidateArtifactsBestEffort(params.rollback);
  return {
    ...params.installStep,
    durationMs: Date.now() - params.startedAt,
    stdoutTail: [
      params.installStep.stdoutTail,
      `restored ${params.rollback.packageName} ${params.rollback.previousVersion}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export async function restoreLivePackageRollback(
  rollback: LivePackageRollback | null,
): Promise<PackageUpdateStepResult | null> {
  if (!rollback?.active) {
    return null;
  }
  rollback.active = false;
  const startedAt = Date.now();
  const installLocation =
    rollback.installTarget.manager === "pnpm"
      ? resolvePnpmGlobalDirFromGlobalRoot(rollback.installTarget.globalRoot)
      : null;
  const argv = globalInstallArgs(
    rollback.installTarget,
    `${rollback.packageName}@file:${rollback.previousArtifactPath}`,
    undefined,
    installLocation,
  );
  let outcome: PackageUpdateStepResult;
  try {
    const installStep = await rollback.runStep({
      name: "global update rollback",
      argv,
      ...(rollback.cwd === undefined ? {} : { cwd: rollback.cwd }),
      ...(rollback.env === undefined ? {} : { env: rollback.env }),
      timeoutMs: rollback.timeoutMs,
    });
    if (installStep.exitCode !== 0) {
      outcome = preserveArtifactFailure(rollback, installStep);
    } else if (rollback.previousPostinstall) {
      const postinstallStep = await rollback.runStep({
        name: "global update rollback postinstall",
        argv: [
          rollback.nodePath!,
          path.join(rollback.packageRoot, PACKAGE_POSTINSTALL_RELATIVE_PATH),
        ],
        cwd: rollback.packageRoot,
        ...(rollback.env === undefined ? {} : { env: rollback.env }),
        timeoutMs: rollback.timeoutMs,
      });
      if (postinstallStep.exitCode !== 0) {
        outcome = preserveArtifactFailure(rollback, {
          ...postinstallStep,
          name: "global update rollback",
        });
      } else {
        outcome = await completeSuccessfulRollback({ rollback, installStep, startedAt });
      }
    } else {
      outcome = await completeSuccessfulRollback({ rollback, installStep, startedAt });
    }
  } catch (error) {
    outcome = rollbackStep({
      name: "global update rollback",
      command: argv.join(" "),
      cwd: rollback.cwd ?? rollback.packageRoot,
      startedAt,
      error: new Error(
        `${formatErrorMessage(error)}; rollback artifact preserved at ${rollback.previousArtifactPath}`,
      ),
    });
  }
  try {
    await releaseLivePackageLock(rollback);
  } catch (error) {
    outcome = rollbackStep({
      name: "global update rollback",
      command: argv.join(" "),
      cwd: rollback.cwd ?? rollback.packageRoot,
      startedAt,
      error: new AggregateError(
        [new Error(outcome.stderrTail ?? "rollback completed"), error],
        `rollback lock release failed; artifact preserved at ${rollback.previousArtifactPath}`,
      ),
    });
  }
  return outcome;
}

export async function finalizeLivePackageRollback(
  rollback: LivePackageRollback | null,
  failedStep: PackageUpdateStepResult | null,
): Promise<{
  failedStep: PackageUpdateStepResult | null;
  rollbackStep: PackageUpdateStepResult | null;
}> {
  if (!failedStep) {
    await discardLivePackageRollback(rollback);
    return { failedStep: null, rollbackStep: null };
  }
  const restoreStep = await restoreLivePackageRollback(rollback);
  return {
    failedStep: restoreStep && restoreStep.exitCode !== 0 ? restoreStep : failedStep,
    rollbackStep: restoreStep,
  };
}

export async function throwAfterLivePackageRollback(
  rollback: LivePackageRollback | null,
  error: unknown,
): Promise<never> {
  const restoreStep = await restoreLivePackageRollback(rollback);
  if (restoreStep && restoreStep.exitCode !== 0) {
    throw new AggregateError([error, new Error(restoreStep.stderrTail ?? "rollback failed")]);
  }
  throw error;
}

export async function discardLivePackageRollback(
  rollback: LivePackageRollback | null,
): Promise<void> {
  if (!rollback?.active) {
    return;
  }
  rollback.active = false;
  try {
    await fs.rm(rollback.previousArtifactPath, { force: true }).catch(() => undefined);
    await fs.rmdir(rollback.artifactDir).catch(() => undefined);
  } finally {
    await releaseLivePackageLock(rollback);
  }
}
