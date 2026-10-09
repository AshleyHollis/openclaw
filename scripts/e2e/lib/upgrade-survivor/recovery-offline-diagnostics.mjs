// Fixed, numeric recovery receipts. No command lines, environments, or paths are published.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const recoveryReceiptLimit = 256 * 1024;
const rowLimit = 2048;
const checkpointLimit = 64;
const stages = new Set(["baseline-snapshot", "offline"]);
const steps = new Set([
  "consent-status",
  "retry-status",
  "replacement-status",
  "process",
  "originals",
  "inspect-before",
  "snapshot-before",
  "preview",
  "inventory",
  "snapshot-assert-preview",
  "snapshot-assert-no-consent",
  "snapshot-assert-apply-snapshot",
  "snapshot-assert-retry",
  "snapshot-assert-replacement",
  "assert-preview",
  "no-consent",
  "assert-no-consent",
  "apply",
  "moves",
  "assert-applied",
  "assert-apply-snapshot",
  "snapshot-retry",
  "retry",
  "assert-retry",
  "snapshot-replacement",
  "recreate",
  "replacement",
  "assert-replacement",
  "inspect-after",
  "evidence",
]);
const statuses = new Set(["started", "completed", "failed", "sample"]);
const numeric = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const read = (file) => {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(4096);
      return buffer.subarray(0, fs.readSync(fd, buffer)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
};
const memoryFields = [
  "currentBytes",
  "maxBytes",
  "peakBytes",
  "low",
  "high",
  "max",
  "oom",
  "oomKill",
  "oomGroupKill",
];

export function readRecoveryResources({
  procRoot = "/proc",
  cgroupRoot = "/sys/fs/cgroup",
  childPid = null,
} = {}) {
  const processes = new Map();
  let names = [];
  try {
    names = fs.readdirSync(procRoot).filter((name) => /^\d+$/u.test(name));
  } catch {}
  for (const name of names.slice(0, 4096)) {
    const text = read(path.join(procRoot, name, "status"));
    const rss = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(text);
    const parent = /^PPid:\s+(\d+)$/mu.exec(text);
    if (rss && parent)
      processes.set(Number(name), { rss: Number(rss[1]), parent: Number(parent[1]) });
  }
  const descendants = new Set(childPid === null ? [] : [childPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, value] of processes) {
      if (!descendants.has(pid) && descendants.has(value.parent)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  let descendantRssKiB = 0;
  let otherLargestRssKiB = 0;
  let otherRssKiB = 0;
  let otherProcessCount = 0;
  for (const [pid, value] of processes) {
    if (descendants.has(pid) && pid !== childPid) descendantRssKiB += value.rss;
    else if (pid !== process.pid && pid !== childPid) {
      otherLargestRssKiB = Math.max(otherLargestRssKiB, value.rss);
      otherRssKiB += value.rss;
      otherProcessCount += 1;
    }
  }
  const number = (file) => {
    const text = read(path.join(cgroupRoot, file)).trim();
    return /^\d+$/u.test(text) ? numeric(Number(text)) : null;
  };
  const events = Object.fromEntries(
    read(path.join(cgroupRoot, "memory.events"))
      .trim()
      .split("\n")
      .map((line) => line.split(/\s+/u)),
  );
  return {
    observerRssKiB: numeric(
      processes.get(process.pid)?.rss ?? Math.ceil(process.memoryUsage().rss / 1024),
    ),
    childRssKiB: numeric(processes.get(childPid)?.rss),
    descendantRssKiB: numeric(descendantRssKiB),
    otherLargestRssKiB: numeric(otherLargestRssKiB),
    otherRssKiB: numeric(otherRssKiB),
    otherProcessCount,
    processScanTruncated: names.length > 4096,
    cgroup: {
      currentBytes: number("memory.current"),
      maxBytes: number("memory.max"),
      peakBytes: number("memory.peak"),
      unlimited: read(path.join(cgroupRoot, "memory.max")).trim() === "max",
      ...Object.fromEntries(
        ["low", "high", "max", "oom", "oomKill", "oomGroupKill"].map((key) => [
          key,
          numeric(
            Number(events[key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)] ?? NaN),
          ),
        ]),
      ),
    },
  };
}

export function projectRecoveryReceipt(row) {
  if (
    row?.schemaVersion !== 1 ||
    !stages.has(row.stage) ||
    !steps.has(row.step) ||
    !statuses.has(row.status)
  )
    return null;
  const result = {
    source: ["observer", "worker"].includes(row.source) ? row.source : null,
    atUnixMs: numeric(row.atUnixMs),
    sampleKind: ["recent", "peak"].includes(row.sampleKind) ? row.sampleKind : null,
    schemaVersion: 1,
    stage: row.stage,
    step: row.step,
    status: row.status,
    elapsedMs: numeric(row.elapsedMs),
  };
  for (const key of [
    "exitCode",
    "observerRssKiB",
    "childRssKiB",
    "descendantRssKiB",
    "otherLargestRssKiB",
    "otherRssKiB",
    "otherProcessCount",
    "entries",
    "files",
    "bytes",
  ])
    result[key] = numeric(row[key]);
  result.signal = ["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"].includes(row.signal)
    ? row.signal
    : null;
  result.processScanTruncated = row.processScanTruncated === true;
  result.cgroup = Object.fromEntries(memoryFields.map((key) => [key, numeric(row.cgroup?.[key])]));
  result.cgroup.unlimited = row.cgroup?.unlimited === true;
  result.cgroup.peakScope = "whole-cgroup-lifetime";
  result.cleanupProved = typeof row.cleanupProved === "boolean" ? row.cleanupProved : null;
  return result;
}

export function projectRecoveryReceipts(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > recoveryReceiptLimit) return [];
  const rows = [];
  for (const line of text.split("\n").slice(0, 512)) {
    if (Buffer.byteLength(line) > rowLimit) continue;
    try {
      const row = projectRecoveryReceipt(JSON.parse(line));
      if (row) rows.push(row);
    } catch {}
  }
  return rows;
}

export function appendRecoveryReceipt(artifactRoot, row) {
  try {
    appendRecoveryReceiptUnsafe(artifactRoot, row);
  } catch {}
}

function appendRecoveryReceiptUnsafe(artifactRoot, row) {
  const projected = projectRecoveryReceipt(row);
  if (!projected) return;
  if (row.status === "sample") {
    const file = path.join(artifactRoot, "recovery-offline-samples.jsonl");
    let prior = [];
    if (fs.existsSync(file)) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > recoveryReceiptLimit) return;
        prior = projectRecoveryReceipts(fs.readFileSync(fd, "utf8"));
      } finally {
        fs.closeSync(fd);
      }
    }
    const own = prior.filter((entry) => entry.stage === row.stage);
    const previousPeak = own.find((entry) => entry.sampleKind === "peak");
    const peak = { ...projected, sampleKind: "peak", cgroup: { ...projected.cgroup } };
    for (const key of [
      "observerRssKiB",
      "childRssKiB",
      "descendantRssKiB",
      "otherLargestRssKiB",
      "otherRssKiB",
      "otherProcessCount",
    ]) {
      peak[key] =
        projected[key] === null && previousPeak?.[key] == null
          ? null
          : numeric(Math.max(projected[key] ?? 0, previousPeak?.[key] ?? 0));
    }
    for (const key of memoryFields)
      peak.cgroup[key] =
        projected.cgroup[key] === null && previousPeak?.cgroup[key] == null
          ? null
          : numeric(Math.max(projected.cgroup[key] ?? 0, previousPeak?.cgroup[key] ?? 0));
    const rows = [
      ...prior.filter((entry) => entry.stage !== row.stage),
      peak,
      ...own.filter((entry) => entry.sampleKind === "recent").slice(-30),
      { ...projected, sampleKind: "recent" },
    ];
    const temporary = `${file}.${process.pid}.tmp`;
    let owned = false;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      owned = true;
      try {
        fs.writeFileSync(fd, rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
    } finally {
      if (owned) fs.rmSync(temporary, { force: true });
    }
    return;
  }
  const line = JSON.stringify(projected) + "\n";
  const file = path.join(artifactRoot, "recovery-offline-resources.jsonl");
  try {
    const fd = fs.openSync(
      file,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > checkpointLimit * rowLimit) return;
      const existingRows = projectRecoveryReceipts(fs.readFileSync(fd, "utf8")).length;
      if (
        existingRows < checkpointLimit &&
        Buffer.byteLength(line) <= rowLimit &&
        stat.size + Buffer.byteLength(line) <= checkpointLimit * rowLimit
      )
        fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* Diagnostics must not replace the existing proof outcome. */
  }
}

export async function recoveryOfflineStep(artifactRoot, stage, step, operation, snapshot = false) {
  const start = performance.now();
  const receipt = (status, extra = {}) => {
    try {
      appendRecoveryReceipt(artifactRoot, {
        source: "worker",
        atUnixMs: Date.now(),
        schemaVersion: 1,
        stage,
        step,
        status,
        elapsedMs: Math.floor(performance.now() - start),
        ...readRecoveryResources(),
        ...extra,
      });
    } catch {}
  };
  receipt("started");
  try {
    const result = await operation();
    let counts = {};
    if (snapshot) {
      let entries = 0;
      let files = 0;
      let bytes = 0;
      for (const value of Object.values(result)) {
        entries += 1;
        if (Number.isSafeInteger(value.size)) {
          files += 1;
          bytes += value.size;
        }
      }
      counts = { entries, files, bytes };
    }
    receipt("completed", counts);
    return result;
  } catch (error) {
    receipt("failed");
    throw error;
  }
}

export async function observeRecoveryProcess(
  artifactRoot,
  stage,
  command,
  args,
  { killGraceMs = 30_000 } = {},
) {
  const child = spawn(command, args, { stdio: "inherit", detached: process.platform !== "win32" });
  const signalGroup = (signal) => {
    if (!child.pid) return;
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
    } catch {}
  };
  const groupAlive = () => {
    if (!child.pid) return false;
    if (process.platform !== "win32") {
      try {
        for (const name of fs.readdirSync("/proc").filter((entry) => /^\d+$/u.test(entry))) {
          const text = read(`/proc/${name}/stat`);
          const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
          if (Number(fields[2]) === child.pid && !["Z", "X"].includes(fields[0])) return true;
        }
        return false;
      } catch {
        return true;
      }
    }
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const joinGroup = async () => {
    if (!groupAlive()) return true;
    // A cancelled measure owner is already draining its detached child group.
    // Sending SIGTERM twice would bypass its process.once handler.
    if (!parentSignal) signalGroup("SIGTERM");
    const deadline = performance.now() + killGraceMs;
    while (groupAlive() && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    if (groupAlive()) signalGroup("SIGKILL");
    const killDeadline = performance.now() + 1000;
    while (groupAlive() && performance.now() < killDeadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    return !groupAlive();
  };
  const start = performance.now();
  const receipt = (status, extra = {}) => {
    try {
      appendRecoveryReceipt(artifactRoot, {
        source: "observer",
        atUnixMs: Date.now(),
        schemaVersion: 1,
        stage,
        step: "process",
        status,
        elapsedMs: Math.floor(performance.now() - start),
        ...readRecoveryResources({ childPid: child.pid }),
        ...extra,
      });
    } catch {}
  };
  receipt("started");
  let timer;
  const sample = () => {
    try {
      receipt("sample");
    } catch {}
    timer = setTimeout(sample, 1000);
  };
  timer = setTimeout(sample, 1000);
  let signalTimer;
  let parentSignal = null;
  let forwardedSignals = 0;
  const listeners = new Map(
    ["SIGTERM", "SIGINT", "SIGHUP"].map((signal) => [
      signal,
      () => {
        parentSignal ??= signal;
        forwardedSignals += 1;
        if (forwardedSignals === 1) {
          signalGroup(signal);
          signalTimer = setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
        }
      },
    ]),
  );
  for (const [signal, listener] of listeners) process.on(signal, listener);
  return await new Promise((resolve) => {
    let finished = false;
    const finish = async (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const cleanupProved = await joinGroup();
      clearTimeout(signalTimer);
      for (const [name, listener] of listeners) process.off(name, listener);
      try {
        receipt("sample");
      } catch {}
      signal = parentSignal ?? signal;
      const finalCode = signal
        ? ({ SIGTERM: 143, SIGINT: 130, SIGHUP: 129, SIGKILL: 137 }[signal] ?? 1)
        : code === 0 && !cleanupProved
          ? 1
          : code;
      receipt(finalCode === 0 ? "completed" : "failed", {
        exitCode: finalCode,
        signal,
        cleanupProved,
      });
      resolve(
        signal
          ? ({ SIGTERM: 143, SIGINT: 130, SIGHUP: 129, SIGKILL: 137 }[signal] ?? 1)
          : (finalCode ?? 1),
      );
    };
    child.once("error", () => finish(1, null));
    child.once("exit", finish);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stage = process.argv[2];
  const artifactRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  if (!stages.has(stage) || !artifactRoot) process.exitCode = 2;
  else
    process.exitCode = await observeRecoveryProcess(artifactRoot, stage, process.execPath, [
      "scripts/e2e/lib/upgrade-survivor/recovery-cleanup.mjs",
      stage,
    ]);
}
