import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type Step = {
  name: string;
  id?: string;
  run?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
};
const workflow = parse(readFileSync(resolve(".github/workflows/validate-downstream.yml"), "utf8"));
const job = workflow.jobs["root-test-typecheck"];
const steps = job.steps as Step[];
const admitted = "d7d039c8ed935dce3b207f312307c439e2b9da31";
const dirs = useAutoCleanupTempDirTracker(afterEach);
function fixture() {
  const root = dirs.make("exact-root-typecheck-");
  return {
    root,
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: root,
      GITHUB_OUTPUT: join(root, "outputs"),
      ADMITTED_SOURCE_SHA: job.env.ADMITTED_SOURCE_SHA,
      SOURCE_SHA: admitted,
      TOOLING_SHA: "e".repeat(40),
    },
  };
}
function run(name: string, f: ReturnType<typeof fixture>, env = {}) {
  const step = steps.find((row) => row.name === name);
  if (!step?.run) throw new Error(`missing registered workflow step ${name}`);
  return spawnSync("bash", ["-c", step.run], {
    cwd: f.root,
    env: { ...f.env, ...env },
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
  });
}
function receipt(f: ReturnType<typeof fixture>) {
  return JSON.parse(readFileSync(join(f.root, "root-test-typecheck/receipt.json"), "utf8"));
}

it("keeps the source check opt-in, owner-only, read-only, and pinned to the physical setup owner", () => {
  expect(workflow.on.workflow_dispatch.inputs.root_test_typecheck.default).toBe(false);
  expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
  expect(job.if).toContain("inputs.root_test_typecheck");
  expect(job.if).toContain("github.repository == 'AshleyHollis/openclaw'");
  expect(job.if).toContain("github.actor == github.repository_owner");
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(job.permissions).toEqual({ contents: "read" });
  expect(job.env.ADMITTED_SOURCE_SHA).toBe(admitted);
  const checkout = steps.find((step) => step.name === "Checkout exact source")!;
  expect(steps[0].name).toBe("Admit exact source");
  expect(checkout.with).toEqual({
    ref: "${{ steps.admission.outputs.sha }}",
    "fetch-depth": 1,
    "persist-credentials": false,
  });
  const setup = steps.find((step) => step.id === "setup")!;
  expect(setup.uses).toBe("./.github/actions/setup-node-env");
  expect(setup.with).toEqual({
    "node-version": "24.21.0",
    "semantic-checks": "true",
    "install-bun": "false",
    "cache-mode": "off",
    "frozen-lockfile": "true",
  });
  expect(steps.findIndex((step) => step.id === "binding")).toBeLessThan(steps.indexOf(setup));
  expect(steps.find((step) => step.id === "typecheck")?.run).toContain(
    "node scripts/run-tsgo-core-test-shards.mjs root",
  );
  expect(steps.at(-1)?.if).toBe("always()");
  expect(steps.at(-1)?.uses).toBe(
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  );
});

it
  .skipIf(process.platform === "win32")
  .each(["", "a".repeat(39), admitted.toUpperCase(), `${admitted}\n`, "f".repeat(40)])(
  "rejects malformed or unreviewed SHA before exposing a checkout ref (%j)",
  (source) => {
    const f = fixture();
    const result = run("Admit exact source", f, { SOURCE_SHA: source });
    expect(result.status).not.toBe(0);
    expect(receipt(f).admission).toBe("rejected");
    expect(receipt(f).requestedSourceSha).toBe(source === "f".repeat(40) ? source : null);
    expect(() => readFileSync(f.env.GITHUB_OUTPUT)).toThrow();
  },
);

it.skipIf(process.platform === "win32")(
  "binds the admitted source and rejects an actual mismatched Git checkout before setup",
  () => {
    const f = fixture();
    const admission = run("Admit exact source", f);
    expect(admission.status, admission.stderr).toBe(0);
    expect(readFileSync(f.env.GITHUB_OUTPUT, "utf8")).toBe(`sha=${admitted}\n`);
    for (const args of [
      ["init", "--quiet"],
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fixture",
      ],
    ]) {
      const result = spawnSync("git", args, { cwd: f.root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    const binding = run("Bind source checkout", f, { REQUESTED_SHA: admitted });
    expect(binding.status).not.toBe(0);
    expect(receipt(f).sourceBound).toBe(false);
    expect(receipt(f).checkoutSha).toMatch(/^[a-f0-9]{40}$/u);
  },
);

it.skipIf(process.platform === "win32").each([0, 17])(
  "retains actual child exit %i and always-captured outcomes with a bounded log",
  (code) => {
    const f = fixture();
    expect(run("Admit exact source", f).status).toBe(0);
    mkdirSync(join(f.root, "scripts"));
    writeFileSync(
      join(f.root, "scripts/run-tsgo-core-test-shards.mjs"),
      `if(process.argv[2] !== 'root') process.exit(99); process.stdout.write('first-cause'+ 'x'.repeat(1100000)+'final-diagnostic\\n'); process.exit(${code});`,
    );
    const child = run("Typecheck root tests", f);
    expect(child.status, child.stderr).toBe(code);
    expect(child.stdout.startsWith("first-cause")).toBe(true);
    expect(child.stdout.endsWith("final-diagnostic\n")).toBe(true);
    const capture = run("Record check outcomes", f, {
      ADMISSION_OUTCOME: "success",
      BINDING_OUTCOME: "success",
      SETUP_OUTCOME: "success",
      TYPECHECK_OUTCOME: code ? "failure" : "success",
    });
    expect(capture.status, capture.stderr).toBe(0);
    expect(receipt(f)).toMatchObject({
      requestedSourceSha: admitted,
      admittedSourceSha: admitted,
      toolingSha: f.env.TOOLING_SHA,
      typecheckExitCode: code,
      nodeVersion: process.version,
      logBytesRetained: 1048576,
      outcomes: {
        admission: "success",
        binding: "success",
        setup: "success",
        typecheck: code ? "failure" : "success",
      },
    });
    expect(receipt(f).logBytesOriginal).toBeGreaterThan(1048576);
    expect(statSync(join(f.root, "root-test-typecheck/typecheck.log")).size).toBe(1048576);
  },
);

it.skipIf(process.platform === "win32")(
  "retains failed admission and skipped setup/typecheck without promoting unsafe outcome text",
  () => {
    const f = fixture();
    expect(run("Admit exact source", f, { SOURCE_SHA: "unreviewed" }).status).not.toBe(0);
    const capture = run("Record check outcomes", f, {
      ADMISSION_OUTCOME: "failure",
      BINDING_OUTCOME: "skipped",
      SETUP_OUTCOME: "skipped",
      TYPECHECK_OUTCOME: "private-untrusted-text",
    });
    expect(capture.status, capture.stderr).toBe(0);
    expect(receipt(f)).toMatchObject({
      requestedSourceSha: null,
      typecheckExitCode: null,
      outcomes: {
        admission: "failure",
        binding: "skipped",
        setup: "skipped",
        typecheck: "unknown",
      },
    });
  },
);
