import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  collectNpmFailureDiagnostics,
  summarizeNpmFailureLog,
} from "../scripts/npm-failure-diagnostics.mjs";

describe("npm failure diagnostics", () => {
  it("keeps the actual workflow command status even when diagnostics fail", () => {
    const workflow = parse(
      fs.readFileSync(
        new URL("../.github/workflows/openclaw-live-and-e2e-checks-reusable.yml", import.meta.url),
        "utf8",
      ),
    );
    const step = Object.values(workflow.jobs)
      .flatMap((job: any) => job.steps ?? [])
      .find((item: any) => item.name === "Pack prerelease plugin registry artifact");
    const trap = step.run.split("\n").find((line: string) => line.startsWith("trap "));
    expect(step.env.NPM_CONFIG_LOGS_DIR).toBe("${{ runner.temp }}/openclaw-companion-npm-logs");
    expect(trap).toBeDefined();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-diagnostics-workflow-test-"));
    try {
      const scripts = path.join(dir, ".release-harness/scripts");
      const logs = path.join(dir, "logs");
      fs.mkdirSync(scripts, { recursive: true });
      fs.mkdirSync(logs);
      fs.copyFileSync(
        new URL("../scripts/npm-failure-diagnostics.mjs", import.meta.url),
        path.join(scripts, "npm-failure-diagnostics.mjs"),
      );
      fs.writeFileSync(
        path.join(logs, "2026-10-09T00_08_37_185Z-debug-0.log"),
        "0 verbose node v24.21.0",
      );
      const run = (command: string) =>
        spawnSync(
          "bash",
          [
            "--noprofile",
            "--norc",
            "-c",
            `set -euo pipefail\n${trap}\n${command}\nprintf 'success-only'`,
          ],
          { cwd: dir, encoding: "utf8", env: { ...process.env, NPM_CONFIG_LOGS_DIR: logs } },
        );
      const failure = run("(exit 37)");
      expect(failure.status).toBe(37);
      expect(failure.stdout).toBe("");
      expect(failure.stderr).toContain('"version":"v24.21.0"');
      fs.rmSync(logs, { recursive: true });
      fs.writeFileSync(logs, "SECRET");
      const diagnosticsFailure = run("(exit 37)");
      expect(diagnosticsFailure.status).toBe(37);
      expect(diagnosticsFailure.stderr).toBe('{"npmFailureDiagnosticsUnavailable":true}\n');
      expect(diagnosticsFailure.stderr).not.toContain(dir);
      const success = run("true");
      expect(success.status).toBe(0);
      expect(success.stderr).toBe("");
      expect(success.stdout).toBe("success-only");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("retains stalled operations without exposing raw configuration, messages or paths", () => {
    const records = summarizeNpmFailureLog(
      [
        "0 verbose cli /private/person/node /private/person/npm-cli.js",
        "1 info using npm@11.19.0",
        "2 verbose npm  v11.19.0",
        "3 verbose node v24.21.0",
        "4 verbose stack Error: https://user:SECRET@example.test/?token=SECRET",
        "5 verbose stack     at Pack.exec (/private/SECRET/npm/lib/commands/pack.js:42:7)",
        "6 verbose unfinished npm timer command:pack 1780000000000",
        "7 timing npm:load Completed in 12ms",
        "8 error code EINVALIDPACK",
        "9 error private message SECRET",
        "10 verbose config _authToken=SECRET",
        "11 verbose unfinished npm timer https://SECRET 1780000000000",
      ].join("\n"),
    );
    expect(records).toEqual([
      { kind: "version", tool: "npm", version: "v11.19.0" },
      { kind: "version", tool: "node", version: "v24.21.0" },
      { kind: "stack-location", function: "Pack.exec", file: "pack.js", line: 42, column: 7 },
      { kind: "unfinished-timer", timer: "command:pack" },
      { kind: "timing", timer: "npm:load", milliseconds: 12 },
      { kind: "error-code", code: "EINVALIDPACK" },
    ]);
    expect(JSON.stringify(records)).not.toMatch(/SECRET|private|example/);
  });

  it("reads only bounded npm debug files and tolerates an absent log directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-failure-diagnostics-test-"));
    try {
      expect(collectNpmFailureDiagnostics(path.join(dir, "absent"))).toEqual([]);
      fs.writeFileSync(path.join(dir, "unrelated.log"), "0 verbose node v99.0.0");
      fs.writeFileSync(
        path.join(dir, "2026-10-09T00_08_37_185Z-debug-0.log"),
        "0 verbose node v24.21.0",
      );
      fs.writeFileSync(
        path.join(dir, "2026-10-09T00_08_38_185Z-debug-0.log"),
        "x".repeat(1024 * 1024 + 1),
      );
      expect(collectNpmFailureDiagnostics(dir)).toEqual([
        { kind: "version", tool: "node", version: "v24.21.0" },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
