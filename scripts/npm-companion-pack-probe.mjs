import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

// The existing candidate-only producer supplies a frozen, secretless source
// checkout. Run the actual package owner; do not substitute a flattened tree.
const observer = new URL("./npm-pack-phase-observer.mjs", import.meta.url).href;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-companion-probe-"));
const results = [];
const publicPhases = new Set([
  "npm",
  "npm:load",
  "npm:load:configload",
  "npm:load:mkdirpcache",
  "npm:load:mkdirplogs",
  "npm:load:setTitle",
  "npm:load:display",
  "npm:load:logFile",
  "npm:load:timers",
  "command:pack",
  "arborist:ctor",
  "arborist:loadActual",
]);
function phaseRecord(line) {
  if (!line.startsWith('{"npmPendingPublicPhases":') || line.length > 1024) return null;
  try {
    const value = JSON.parse(line);
    const phases = value.npmPendingPublicPhases;
    if (
      Object.keys(value).length !== 1 ||
      !Array.isArray(phases) ||
      phases.length > publicPhases.size ||
      !phases.every((phase) => publicPhases.has(phase))
    )
      return null;
    return { npmPendingPublicPhases: [...new Set(phases)].sort() };
  } catch {
    return null;
  }
}
try {
  for (const observed of [false, true]) {
    const destination = path.join(root, observed ? "observed" : "baseline");
    fs.mkdirSync(destination);
    const start = performance.now();
    const result = spawnSync(
      process.execPath,
      [
        "scripts/lib/plugin-npm-package-manifest.mjs",
        "--run",
        "extensions/codex",
        "--",
        "npm",
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        destination,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NPM_CONFIG_LOGS_DIR: path.join(destination, "npm-logs"),
          NODE_OPTIONS: [process.env.NODE_OPTIONS, observed && `--import=${observer}`]
            .filter(Boolean)
            .join(" "),
        },
      },
    );
    const phases = String(result.stderr).split(/\r?\n/).map(phaseRecord).filter(Boolean);
    const record = {
      observed,
      status: result.status,
      signal: result.signal,
      errorCode: result.error?.code ?? null,
      elapsedMs: Math.round(performance.now() - start),
      node: process.version,
      phaseRecords: phases,
      exitHandlerFailure: String(result.stderr).includes("Exit handler never called!"),
      patchedFsSafeFailure: String(result.stderr).includes(
        "packing patched runtime dependency failed: @openclaw/fs-safe@0.21.1",
      ),
    };
    results.push(record);
    console.log(JSON.stringify(record));
  }
  // Preserve actual failure. Diagnostic execution never grants qualification.
  process.exitCode = results.some((result) => result.status !== 0) ? 1 : 0;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
