import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  appendRecoveryReceipt,
  observeRecoveryProcess,
  projectRecoveryReceipts,
  readRecoveryResources,
} from "../../scripts/e2e/lib/upgrade-survivor/recovery-offline-diagnostics.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const observer = path.resolve("scripts/e2e/lib/upgrade-survivor/recovery-offline-diagnostics.mjs");
const base = {
  schemaVersion: 1,
  stage: "offline",
  step: "process",
  status: "sample",
  elapsedMs: 0,
};
const rows = (root: string, name = "resources") =>
  projectRecoveryReceipts(
    fs.readFileSync(path.join(root, `recovery-offline-${name}.jsonl`), "utf8"),
  );

it("attributes numeric RSS across observer, child, descendants and unrelated overlap", () => {
  const root = dirs.make("offline-proc-");
  const proc = path.join(root, "proc");
  const cgroup = path.join(root, "cgroup");
  fs.mkdirSync(cgroup);
  for (const [pid, parent, rss] of [
    [process.pid, 1, 10],
    [201, process.pid, 20],
    [202, 201, 30],
    [203, 202, 40],
    [204, 1, 50],
    [205, 1, 60],
  ]) {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    fs.writeFileSync(
      path.join(proc, String(pid), "status"),
      `Name:\tPRIVATE\nPPid:\t${parent}\nVmRSS:\t${rss} kB\n`,
    );
  }
  for (const [name, text] of Object.entries({
    "memory.current": "100",
    "memory.max": "200",
    "memory.peak": "150",
    "memory.events": "low 1\nhigh 2\nmax 3\noom 4\noom_kill 5\noom_group_kill 6",
  }))
    fs.writeFileSync(path.join(cgroup, name), text);
  const resource = readRecoveryResources({ procRoot: proc, cgroupRoot: cgroup, childPid: 201 });
  expect(resource).toMatchObject({
    observerRssKiB: 10,
    childRssKiB: 20,
    descendantRssKiB: 70,
    otherLargestRssKiB: 60,
    otherRssKiB: 110,
    otherProcessCount: 2,
    cgroup: { currentBytes: 100, maxBytes: 200, peakBytes: 150, oomKill: 5, oomGroupKill: 6 },
  });
  expect(JSON.stringify(resource)).not.toContain("PRIVATE");
});

it("keeps fixed checkpoints, latest samples and numeric peaks across long stages", () => {
  const root = dirs.make("offline-ring-");
  appendRecoveryReceipt(root, { ...base, step: "snapshot-before", status: "started" });
  for (let index = 0; index < 1500; index += 1)
    appendRecoveryReceipt(root, {
      ...base,
      elapsedMs: index,
      childRssKiB: index === 1 ? 9999 : index,
    });
  appendRecoveryReceipt(root, { ...base, step: "assert-preview", status: "failed" });
  expect(rows(root).map((row) => row.step)).toEqual(["snapshot-before", "assert-preview"]);
  const samples = rows(root, "samples");
  expect(samples).toHaveLength(32);
  expect(samples[0]).toMatchObject({ sampleKind: "peak", childRssKiB: 9999 });
  expect(samples.at(-1)).toMatchObject({ elapsedMs: 1499, childRssKiB: 1499 });
  expect(fs.statSync(path.join(root, "recovery-offline-samples.jsonl")).size).toBeLessThan(262144);
});

it("projects only fixed labels and numeric fields, retaining complete rows before truncation", () => {
  const row = {
    ...base,
    status: "started",
    argv: ["PRIVATE"],
    path: "/private",
    elapsedMs: "PRIVATE",
    cgroup: { peakBytes: "PRIVATE", oomKill: 3 },
  };
  const text =
    JSON.stringify(row) + "\n" + JSON.stringify({ ...row, step: "PRIVATE" }) + "\n" + "partial";
  const projected = projectRecoveryReceipts(text);
  expect(projected).toHaveLength(1);
  expect(projected[0]).toMatchObject({ elapsedMs: null, cgroup: { peakBytes: null, oomKill: 3 } });
  expect(JSON.stringify(projected)).not.toContain("PRIVATE");
  expect(projectRecoveryReceipts("x".repeat(262145))).toEqual([]);
  expect(projectRecoveryReceipts(JSON.stringify({ ...base, untrusted: "x".repeat(2048) }))).toEqual(
    [],
  );
});

function offlineFixture(fault = "none") {
  const root = dirs.make("offline-entry-");
  const artifacts = path.join(root, "artifacts");
  const home = path.join(root, "home");
  const state = path.join(home, "state");
  const runtime = path.join(root, "runtime");
  const bin = path.join(root, "bin");
  for (const directory of [artifacts, state, runtime, bin])
    fs.mkdirSync(directory, { recursive: true });
  const archive = path.join(state, "archive");
  fs.writeFileSync(archive, "data");
  const manifest = path.join(state, "session-sqlite-migration-runs/run.json");
  fs.mkdirSync(path.dirname(manifest));
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      targets: [
        {
          sqlitePath: path.join(state, "db"),
          completedMoves: [{ archivePath: archive, artifact: { disposal: { state: "retained" } } }],
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(artifacts, "recovery-evidence.json"),
    JSON.stringify({ originals: [{ archive, disposition: "candidate", identity: { size: 4 } }] }),
  );
  fs.writeFileSync(
    path.join(bin, "openclaw"),
    `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2), state=${JSON.stringify(state)}, archive=${JSON.stringify(archive)}, manifest=${JSON.stringify(manifest)}, marker=${JSON.stringify(path.join(artifacts, "applied"))};
const output=(value,code=0)=>{console.log(JSON.stringify(value));process.exit(code)};
if(args[0]==='doctor') {
  if(${JSON.stringify(fault)}==='inspect') process.exit(3);
  if(${JSON.stringify(fault)}==='killed') {process.kill(process.ppid,'SIGKILL');process.exit(0)}
  output({totals:{sqliteEntries:1}});
}
if(args.includes('--dry-run')) {
  if(${JSON.stringify(fault)}==='mismatch') fs.writeFileSync(state+'/unexpected','changed');
  output({stateDir:state,status:'preview',dryRun:true,artifacts:[{path:archive,outcome:'candidate',bytes:4,reason:'candidate',runs:['run']}],totals:{candidateBytes:4,protectedBytes:1}});
}
if(!args.includes('--yes')) output({stateDir:state,status:'refused'},1);
if(!fs.existsSync(marker)) {
  fs.unlinkSync(archive);fs.writeFileSync(marker,'applied');
  const value=JSON.parse(fs.readFileSync(manifest));value.targets[0].completedMoves[0].artifact.disposal={state:'disposed',disposedAt:'2026-01-01'};fs.writeFileSync(manifest,JSON.stringify(value));
  output({stateDir:state,status:'complete',dryRun:false,artifacts:[{path:archive,outcome:'removed',removedBytes:4,reason:'rollback-original-retired'}],totals:{removedFiles:1,removedBytes:4}});
}
output({stateDir:state,status:'complete',dryRun:false,artifacts:[],totals:{removedFiles:0,removedBytes:0}});
`,
    { mode: 0o755 },
  );
  return {
    root,
    artifacts,
    env: {
      PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      HOME: home,
      TMPDIR: runtime,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: runtime,
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
    },
  };
}

it.skipIf(process.platform === "win32")(
  "executes baseline and every offline substep through the actual recovery harness entry with a synthetic installed CLI",
  () => {
    const fixture = offlineFixture();
    for (const stage of ["baseline-snapshot", "offline"]) {
      const result = spawnSync(process.execPath, [observer, stage], {
        env: fixture.env,
        encoding: "utf8",
        timeout: 10000,
      });
      expect(result.status, result.stderr).toBe(0);
    }
    const receipts = rows(fixture.artifacts);
    expect(receipts).toHaveLength(64);
    expect(receipts.at(-1)).toMatchObject({
      stage: "offline",
      step: "process",
      status: "completed",
      cleanupProved: true,
    });
    expect(rows(fixture.artifacts, "samples").length).toBeLessThanOrEqual(64);
    expect(
      receipts.filter(
        (row) =>
          row.stage === "baseline-snapshot" &&
          row.step === "snapshot-before" &&
          row.status === "completed",
      )[0],
    ).toMatchObject({ files: 2, bytes: expect.any(Number) });
    for (const step of [
      "originals",
      "inspect-before",
      "snapshot-before",
      "preview",
      "inventory",
      "snapshot-assert-preview",
      "assert-preview",
      "no-consent",
      "consent-status",
      "assert-no-consent",
      "snapshot-assert-no-consent",
      "apply",
      "moves",
      "assert-applied",
      "snapshot-assert-apply-snapshot",
      "assert-apply-snapshot",
      "snapshot-retry",
      "retry",
      "retry-status",
      "assert-retry",
      "snapshot-assert-retry",
      "recreate",
      "snapshot-replacement",
      "replacement",
      "replacement-status",
      "assert-replacement",
      "snapshot-assert-replacement",
      "inspect-after",
      "evidence",
    ]) {
      expect(
        receipts
          .filter((row) => row.stage === "offline" && row.step === step)
          .map((row) => row.status),
        step,
      ).toEqual(["started", "completed"]);
    }
  },
);

it.skipIf(process.platform === "win32").each(["inspect", "mismatch", "killed"])(
  "retains exact failure boundary on %s without changing assertions",
  (fault) => {
    const fixture = offlineFixture(fault);
    const result = spawnSync(process.execPath, [observer, "offline"], {
      env: fixture.env,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status).toBe(fault === "killed" ? 137 : 1);
    const receipts = rows(fixture.artifacts);
    expect(receipts.at(-1)).toMatchObject({ step: "process", status: "failed" });
    if (fault === "mismatch") {
      expect(receipts).toContainEqual(
        expect.objectContaining({
          step: "snapshot-assert-preview",
          status: "completed",
          entries: expect.any(Number),
        }),
      );
      expect(receipts).toContainEqual(
        expect.objectContaining({ step: "assert-preview", status: "failed" }),
      );
    } else
      expect(receipts).toContainEqual(
        expect.objectContaining({
          step: "inspect-before",
          status: fault === "killed" ? "started" : "failed",
        }),
      );
  },
);

it.skipIf(process.platform === "win32")(
  "observes synchronous child memory and cleans its surviving process group",
  async () => {
    const root = dirs.make("offline-owned-group-");
    const child = path.join(root, "worker.mjs");
    fs.writeFileSync(
      child,
      `import {spawn} from 'node:child_process';
const memory=Buffer.alloc(64*1024*1024,1);
const sibling=spawn(process.execPath,['-e','const b=Buffer.alloc(16*1024*1024,1);setInterval(()=>b[0],1000)'],{stdio:'ignore'});
const until=Date.now()+1300;while(Date.now()<until) memory[0]++;
process.exit(0);`,
    );
    expect(
      await observeRecoveryProcess(root, "offline", process.execPath, [child], { killGraceMs: 50 }),
    ).toBe(0);
    const peak = rows(root, "samples").find((row) => row.sampleKind === "peak");
    expect(peak?.childRssKiB).toBeGreaterThan(64 * 1024);
    expect(peak?.descendantRssKiB).toBeGreaterThan(16 * 1024);
    expect(peak?.observerRssKiB).toBeGreaterThan(0);
  },
);

it.skipIf(process.platform === "win32").each(["handled", "joining"])(
  "preserves cancellation when the child exits zero (%s)",
  (mode) => {
    const root = dirs.make("offline-signal-");
    const child = path.join(root, "child.mjs");
    const runner = path.join(root, "runner.mjs");
    fs.writeFileSync(
      child,
      mode === "handled"
        ? `process.on('SIGTERM',()=>process.exit(0));setTimeout(()=>process.kill(process.ppid,'SIGTERM'),50);setInterval(()=>{},1000);`
        : `import{spawn}from'node:child_process';spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setTimeout(()=>process.kill("+process.ppid+",'SIGTERM'),100);setInterval(()=>{},1000)"],{stdio:'ignore'});setTimeout(()=>process.exit(0),50);`,
    );
    fs.writeFileSync(
      runner,
      `import {observeRecoveryProcess} from ${JSON.stringify(pathToFileURL(observer).href)};process.exitCode=await observeRecoveryProcess(${JSON.stringify(root)},'offline',process.execPath,[${JSON.stringify(child)}],{killGraceMs:300});`,
    );
    const result = spawnSync(process.execPath, [runner], { encoding: "utf8", timeout: 5000 });
    expect(result.status, result.stderr).toBe(143);
    expect(rows(root).at(-1)).toMatchObject({
      status: "failed",
      signal: "SIGTERM",
      exitCode: 143,
      cleanupProved: true,
    });
  },
);

it.skipIf(process.platform === "win32")(
  "preserves proof outcome when diagnostic writes are unavailable",
  async () => {
    const root = dirs.make("offline-unwritable-");
    fs.mkdirSync(path.join(root, "recovery-offline-resources.jsonl"));
    fs.mkdirSync(path.join(root, "recovery-offline-samples.jsonl"));
    expect(
      await observeRecoveryProcess(root, "offline", process.execPath, ["-e", "process.exit(7)"], {
        killGraceMs: 50,
      }),
    ).toBe(7);
  },
);

it.skipIf(process.platform === "win32").each(["symlink", "hardlink"])(
  "does not read or overwrite %s diagnostics targets",
  (mode) => {
    const root = dirs.make("offline-symlink-");
    const outside = path.join(root, "outside");
    fs.writeFileSync(outside, "PRIVATE_SENTINEL");
    for (const name of ["resources", "samples"]) {
      const target = path.join(root, `recovery-offline-${name}.jsonl`);
      if (mode === "symlink") fs.symlinkSync(outside, target);
      else fs.linkSync(outside, target);
    }
    appendRecoveryReceipt(root, { ...base, status: "started" });
    appendRecoveryReceipt(root, base);
    expect(fs.readFileSync(outside, "utf8")).toBe("PRIVATE_SENTINEL");
  },
);

it.skipIf(process.platform === "win32").each([false, true])(
  "joins the actual measured cleanup owner after cancellation (repeated: %s)",
  (repeat) => {
    const root = dirs.make("offline-measured-cancel-");
    const ready = path.join(root, "cli-ready");
    const cli = path.join(root, "cli.mjs");
    const worker = path.join(root, "worker.mjs");
    const runner = path.join(root, "runner.mjs");
    fs.writeFileSync(
      cli,
      `import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`,
    );
    fs.writeFileSync(
      worker,
      `import{execFile}from'node:child_process';execFile(process.execPath,${JSON.stringify([path.resolve("scripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs"), path.join(root, "measured.tsv"), "apply", "--", process.execPath, cli])},()=>process.exit(0));`,
    );
    fs.writeFileSync(
      runner,
      `import fs from 'node:fs';import{observeRecoveryProcess}from ${JSON.stringify(pathToFileURL(observer).href)};
const proof=observeRecoveryProcess(${JSON.stringify(root)},'offline',process.execPath,[${JSON.stringify(worker)}]);
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);process.kill(process.pid,'SIGTERM');if(${repeat})setTimeout(()=>process.kill(process.pid,'SIGTERM'),25)}},10);
process.exitCode=await proof;clearInterval(timer);`,
    );
    const result = spawnSync(process.execPath, [runner], { encoding: "utf8", timeout: 10000 });
    expect(result.status, result.stderr).toBe(143);
    expect(rows(root).at(-1)).toMatchObject({
      status: "failed",
      signal: "SIGTERM",
      exitCode: 143,
      cleanupProved: true,
    });
    const pid = Number(fs.readFileSync(ready, "utf8"));
    let active = false;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      active = state === undefined || !["Z", "X"].includes(state);
    } catch {}
    expect(active, "the measured installed CLI must not remain active").toBe(false);
  },
);
