import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validatePrepublishPluginRegistryArtifact } from "../../../prepublish-plugin-registry-artifact.mjs";

const PRODUCT = "ea4135dbeced9c393ab4f6ebde8bf3e751ea5fa2";
const ARCHIVE = "acf8cd1cedd1b64f6b855c7177fd3340a03208cd9cbf30aeaf5a511d2e2ef470";
const BASELINE = "fc23bc864e4553c2d215e479eeec47b67a0bf943";
const MANIFEST = "1e52816586e4cf01d1d469228027b28e769e6eb6e53518a1e8ffc17b64bdbbee";
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n", { flag: "wx", mode: 0o600 });
export function digest(p) {
  const h = createHash("sha256"); const fd = fs.openSync(p, "r");
  try { const b = Buffer.alloc(1024 * 1024); let n; while ((n = fs.readSync(fd, b, 0, b.length, null))) h.update(b.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest("hex");
}
function contained(root, p) {
  const resolved = path.resolve(p);
  assert(resolved.startsWith(path.resolve(root) + path.sep), "path escaped owned fixture");
  return resolved;
}
function canonical(root, p) {
  const lexical = contained(root, p);
  const resolved = fs.realpathSync(lexical);
  assert.equal(resolved, lexical, "fixture path contains a symlink alias");
  return contained(fs.realpathSync(root), resolved);
}
function regular(p) {
  const s = fs.lstatSync(p); assert(s.isFile() && !s.isSymbolicLink(), "expected regular fixture file");
  return p;
}
function groupMembers(pgid) {
  // Linux is the existing secretless Docker owner, never an arbitrary remote host.
  const result = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const raw = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pgid) result.push({ pid: Number(name), state: fields[0], start: fields[19] });
    } catch (e) { if (!["ENOENT", "ESRCH"].includes(e.code)) throw e; }
  }
  return result;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export function prefixInventory(root) {
  const records = [];
  function walk(relative) {
    const p = path.join(root, relative); const s = fs.lstatSync(p);
    const r = { path: relative, mode: s.mode & 0o777 };
    if (s.isSymbolicLink()) records.push({ ...r, kind: "symlink", target: fs.readlinkSync(p) });
    else if (s.isFile()) records.push({ ...r, kind: "file", bytes: s.size, sha256: digest(p) });
    else { assert(s.isDirectory(), "unsupported prefix entry"); records.push({ ...r, kind: "directory" });
      for (const name of fs.readdirSync(p).sort()) walk(path.join(relative, name)); }
  }
  walk("");
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

// Exported for real OS/process boundary regressions with fictional owned fixtures.
// Production CLI below fixes entry/argv/identity; this is not an authentication API.
export async function interruptDriver({ argv, env, config, directory, timeoutMs = 900000 }) {
  assert.equal(process.platform, "linux");
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 900000);
  const markerPath = path.join(directory, "boundary.json");
  const configPath = path.join(directory, "fault-config.json");
  write(configPath, { ...config, marker: markerPath });
  const out = fs.openSync(path.join(directory, "updater.stdout"), "wx", 0o600);
  const err = fs.openSync(path.join(directory, "updater.stderr"), "wx", 0o600);
  let child; let joined; let terminal; let marker; let problem; let signalled = false; let cancelled;
  const cancel = (signal) => {
    cancelled = signal;
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") problem = `cannot terminate owned group: ${e.message}`; } }
  };
  const handlers = Object.fromEntries(["SIGTERM", "SIGINT", "SIGHUP"].map((s) => [s, () => cancel(s)]));
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  try {
    child = spawn(process.execPath, argv, {
      detached: true, env: { ...env, OPENCLAW_FIRST_HOP_INTERRUPTION_CONFIG: configPath },
      stdio: ["ignore", out, err],
    });
    joined = new Promise((resolve) => {
      child.once("error", (e) => { terminal = { error: e.message }; resolve(terminal); });
      child.once("exit", (code, signal) => { terminal = { code, signal }; resolve(terminal); });
    });
    assert(Number.isSafeInteger(child.pid));
    write(path.join(directory, "started.json"), { runId: config.runId, argv, pid: child.pid, pgid: child.pid, at: new Date().toISOString() });
    const until = Date.now() + timeoutMs;
    while (!terminal && !cancelled && Date.now() < until) {
      if (fs.existsSync(markerPath)) {
        marker = read(regular(markerPath));
        assert.equal(marker.runId, config.runId);
        const members = groupMembers(child.pid);
        assert(members.some((p) => p.pid === marker.pid), "marker writer escaped owned group");
        if (!members.some((p) => p.pid === marker.pid && p.state === "T")) { await delay(20); continue; }
        // Kill, rather than letting the original driver gracefully undo the fault.
        // The pre-repair incomplete state is an essential part of this proof.
        process.kill(-child.pid, "SIGKILL"); signalled = true;
        break;
      }
      await delay(20);
    }
    if (!signalled) {
      problem = "original driver did not reach the real displacement boundary";
      try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
    }
    const stopAt = Date.now() + 10000;
    while (!terminal && Date.now() < stopAt) await delay(20);
    if (!terminal || groupMembers(child.pid).some((p) => p.state !== "Z")) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
    }
    await Promise.race([joined, delay(2000)]);
    assert(terminal, "owned updater did not reach terminal state; outcome unknown");
    for (let i = 0; i < 100 && groupMembers(child.pid).some((p) => p.state !== "Z"); i++) await delay(20);
    const members = groupMembers(child.pid);
    assert(!members.some((p) => p.state !== "Z"), "updater children survived interruption");
    assert(!cancelled, `controller interrupted by ${cancelled}`);
    assert.equal(signalled, true, problem ?? "no controlled interruption");
    assert(terminal.signal || (Number.isInteger(terminal.code) && terminal.code !== 0), "interruption was mislabeled successful");
    return { terminal, marker, markerSha256: digest(markerPath), processGroup: child.pid,
      liveProcessesAfter: [], zombiesAfter: members, parentJoined: true };
  } finally {
    // Cleanup is bounded; unknown surviving effects fail rather than replay.
    let cleanupError;
    try {
      if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; } }
      if (joined) await Promise.race([joined, delay(2000)]);
      if (child?.pid) {
        for (let i = 0; i < 100 && groupMembers(child.pid).some((p) => p.state !== "Z"); i++) await delay(20);
        assert(!groupMembers(child.pid).some((p) => p.state !== "Z"), "unknown live child outcome after cleanup");
        assert(terminal, "unknown unjoined updater outcome after cleanup");
      }
    } catch (e) { cleanupError = e; }
    finally {
      for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
      fs.closeSync(out); fs.closeSync(err);
      write(path.join(directory, "terminal-observation.json"), { terminal: terminal ?? null, signalled, marker: marker ?? null, problem: problem ?? null, controllerSignal: cancelled ?? null, cleanupError: cleanupError?.message ?? null });
    }
    if (cleanupError) throw cleanupError;
  }
}

export function validateInterruptedRestore(proof, result, resultFile) {
  const intentPath = path.join(path.dirname(result.markerPath), "intent.json");
  const intent = read(regular(intentPath));
  assert.equal(digest(intentPath), result.intentSha256, "original interruption intent changed");
  for (const key of ["runId", "originalEntry", "originalEntrySha256", "node", "proofPath", "backupProofSha256", "targetSha256", "originalPackageRoot", "sourceStateDir", "configRelative", "configSha256", "retainedPrefix", "originalPrefixSha256", "companionManifestSha256"]) assert.deepEqual(result[key],intent[key], `interruption binding changed: ${key}`);
  assert.equal(result.schema, "openclaw.first-hop-interruption.v1");
  assert.equal(result.outcome, "interrupted-not-upgraded");
  assert.equal(result.baselineSource, BASELINE); assert.equal(result.baselineVersion, "2026.9.8");
  assert.equal(result.targetSource, PRODUCT); assert.equal(result.targetSha256, ARCHIVE);
  assert.equal(result.companionManifestSha256, MANIFEST);
  assert.equal(result.backupProofSha256, digest(result.proofPath), "captured backup evidence changed");
  assert.equal(result.proofPath, resultFile);
  assert.equal(digest(result.capturedProofPath), result.backupProofSha256, "retained captured backup bytes changed");
  assert.equal(result.retainedManifestSha256, proof.runtime.manifestSha256);
  assert.equal(result.originalEntrySha256, proof.runtime.entrySha256);
  assert.equal(result.backupArchiveSha256, proof.archive.sha256);
  assert.equal(result.sourceStateDir, proof.sourceStateDir);
  assert.equal(prefixInventory(result.retainedPrefix), result.originalPrefixSha256, "retained full prefix changed");
  assert.equal(result.parentJoined, true); assert.deepEqual(result.liveProcessesAfter, []);
  assert(result.terminal.signal || (Number.isInteger(result.terminal.code) && result.terminal.code !== 0));
  const fixtureRoot = fs.realpathSync(process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT);
  canonical(fixtureRoot, result.retainedPrefix);
  assert.equal(path.dirname(result.markerPath), path.join(path.dirname(resultFile), "first-hop-interruption"));
  const marker = read(regular(result.markerPath));
  assert.equal(digest(result.markerPath), result.markerSha256);
  assert.equal(marker.schema, "openclaw.first-hop-interruption-marker.v1");
  assert.equal(marker.baselineVersion, "2026.9.8");
  assert(Number.isSafeInteger(marker.pid) && marker.pid > 0);
  canonical(fixtureRoot, marker.retiredRoot);
  const started = read(regular(path.join(path.dirname(result.markerPath), "started.json")));
  assert.equal(started.runId, result.runId);
  assert.equal(started.pid, result.processGroup);
  assert.equal(started.pgid, result.processGroup);
  assert.deepEqual(started.argv, [result.originalEntry, "update", "--tag", intent.target, "--yes", "--json", "--no-restart", "--channel", "stable"]);
  assert(Number.isFinite(Date.parse(marker.at)) && Date.parse(marker.at) >= Date.parse(started.at), "invalid interruption chronology");
  assert.equal(marker.runId, result.runId); assert.equal(marker.liveRoot, result.originalPackageRoot);
  assert.equal(marker.baselineSource, BASELINE); assert.equal(marker.targetSha256, ARCHIVE);
  assert.equal(marker.boundary, "after-original-prefix-rename-before-candidate-publication");
  assert(!fs.existsSync(result.originalPackageRoot), "candidate ran or live prefix changed after interruption");
  const retired = read(regular(path.join(marker.retiredRoot, "package.json")));
  assert.equal(retired.version, "2026.9.8");
  assert.equal(digest(path.join(marker.retiredRoot, "package.json")), proof.runtime.manifestSha256);
  return result;
}

async function run(proofPath, target, liveRoot, entry) {
  const proof = read(regular(proofPath));
  assert.equal(proof.status, "captured"); assert.equal(proof.baselineVersion, "2026.9.8");
  const fixtureRoot = fs.realpathSync(process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT);
  assert(fs.lstatSync(fixtureRoot).isDirectory());
  const prefix = canonical(fixtureRoot, process.env.npm_config_prefix);
  liveRoot = canonical(prefix, liveRoot); entry = regular(canonical(liveRoot, entry));
  assert.equal(digest(path.join(liveRoot, "package.json")), proof.runtime.manifestSha256);
  assert.equal(digest(entry), proof.runtime.entrySha256);
  const build = read(regular(path.join(liveRoot, "dist/build-info.json")));
  assert.equal(build.commit, BASELINE); assert.equal(build.version, "2026.9.8");
  assert.equal(digest(regular(target)), ARCHIVE, "target archive changed");
  const registry = validatePrepublishPluginRegistryArtifact({
    artifactDir: process.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR,
    expectedCandidateVersion: "2026.9.9", expectedManifestSha256: MANIFEST, expectedSourceSha: PRODUCT,
    requiredPackages: ["@openclaw/codex", "@openclaw/discord", "@openclaw/whatsapp"],
  });
  const directory = path.join(path.dirname(proofPath), "first-hop-interruption");
  fs.mkdirSync(directory, { mode: 0o700 }); // Existing evidence is never replayed.
  const capturedProofPath = path.join(directory, "captured-backup.json");
  fs.copyFileSync(proofPath, capturedProofPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(capturedProofPath, 0o600);
  const runId = randomUUID();
  const configRelative = path.relative(proof.sourceStateDir, process.env.OPENCLAW_CONFIG_PATH);
  assert.equal(configRelative, "openclaw.json", "only the existing isolated default config is supported");
  const configSha256 = digest(regular(process.env.OPENCLAW_CONFIG_PATH));
  const originalPrefixSha256 = prefixInventory(prefix);
  const retainedPrefix = canonical(fixtureRoot, path.resolve(proof.runtime.packageRoot, "../../.."));
  assert.equal(prefixInventory(retainedPrefix), originalPrefixSha256, "retained prefix is not the complete original");
  write(path.join(directory, "intent.json"), { runId, proofPath, backupProofSha256: digest(proofPath),
    target, targetSha256: ARCHIVE, originalEntry: entry, originalEntrySha256: digest(entry),
    originalPackageRoot: liveRoot, baselineSource: BASELINE, companionManifestSha256: registry.manifestSha256,
    sourceStateDir: proof.sourceStateDir, configRelative, configSha256, retainedPrefix, originalPrefixSha256, node: { executable: process.execPath, version: process.version, sha256: digest(process.execPath) }, operation: "interrupt-original9.8-after-real-displacement" });
  const preload = fileURLToPath(new URL("first-hop-interruption-preload.mjs", import.meta.url));
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}` };
  const observed = await interruptDriver({
    argv: [entry, "update", "--tag", target, "--yes", "--json", "--no-restart", "--channel", "stable"], env, directory,
    config: { runId, fixtureRoot, liveRoot, baselineVersion: "2026.9.8", baselineSource: BASELINE, targetSha256: ARCHIVE },
  });
  const result = { schema: "openclaw.first-hop-interruption.v1", outcome: "interrupted-not-upgraded", runId,
    baselineVersion: "2026.9.8", baselineSource: BASELINE, targetSource: PRODUCT, targetSha256: ARCHIVE,
    scope: "isolated published9.8 original-driver displacement, retained-prefix/data rollback and restart; not live Code history or automatic service recovery",
    node: { executable: process.execPath, version: process.version, sha256: digest(process.execPath) },
    companionManifestSha256: registry.manifestSha256, proofPath, backupProofSha256: digest(proofPath),
    capturedProofPath, intentSha256: digest(path.join(directory, "intent.json")),
    retainedManifestSha256: proof.runtime.manifestSha256, originalEntrySha256: proof.runtime.entrySha256,
    backupArchiveSha256: proof.archive.sha256, originalPackageRoot: liveRoot, originalEntry: entry,
    retainedPrefix, originalPrefixSha256,
    sourceStateDir: proof.sourceStateDir, configRelative, configSha256,
    markerPath: path.join(directory, "boundary.json"), ...observed };
  write(path.join(directory, "result.json"), result);
  validateInterruptedRestore(proof, result, proofPath);
  console.log(JSON.stringify({ outcome: result.outcome, result: path.join(directory, "result.json"), upgraded: false, restored: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 6, "usage: first-hop-interruption.mjs CAPTURED_BACKUP TARGET_TGZ ORIGINAL_PACKAGE ORIGINAL_ENTRY");
  await run(...process.argv.slice(2));
}
