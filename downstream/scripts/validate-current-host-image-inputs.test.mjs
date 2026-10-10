import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  validateCurrentHostRecords,
  validateQmdRuntimeRecords,
  validateInstalledQmdRuntime,
} from "./validate-current-host-image-inputs.mjs";
import {
  PAIRED_LIFE_SELECTION,
  QMD_SELECTION,
  validatePairedLifeSelection,
  runtimeSelectionPaths,
} from "./validate-packaged-candidate.mjs";

const read = async (name) =>
  JSON.parse(
    await readFile(new URL(`../runtime-install/current-code/${name}`, import.meta.url), "utf8"),
  );
const candidate = JSON.parse(
  await readFile(
    new URL("../runtime-install/current-code/candidate.json", import.meta.url),
    "utf8",
  ),
);
candidate.role = "paired-life";
candidate.components.qmd = {
  version: "2.1.0",
  url: "https://github.com/AshleyHollis/openclaw/releases/download/qmd-2.1.0-retained-security-20261010/qmd-current.tgz",
  sha256: "8ede318f7424ece8eefcb91ee4757d25c7ad2a6f6811c2e9ffbb6d8755228baf",
};
candidate.locks["qmd.package-lock.json"] = QMD_SELECTION.lockSha256;
candidate.commandCenter = {
  sourceCommit: PAIRED_LIFE_SELECTION.source,
  archiveSha256: PAIRED_LIFE_SELECTION.archive,
  buildDigest: PAIRED_LIFE_SELECTION.build,
  receiptSha256: PAIRED_LIFE_SELECTION.receipt,
  artifact: PAIRED_LIFE_SELECTION.artifact,
  carrierImage: PAIRED_LIFE_SELECTION.carrier,
};
const host = await read("host.package-lock.json");
const plugins = await read("plugins.package-lock.json");
const actual = {
  build: { version: candidate.hostVersion, commit: candidate.hostProducedFrom },
  hostSha256: candidate.hostArchiveSha256,
  hostIntegrity: host.packages["node_modules/openclaw"].integrity,
  codexSha256: candidate.components.codex.sha256,
  codexIntegrity: plugins.packages["node_modules/@openclaw/codex"].integrity,
  qmdSha256: candidate.components.qmd.sha256,
  ccSha256: candidate.commandCenter.archiveSha256,
};
for (const failure of [
  null,
  "public-version-only",
  "old-lock",
  "archive",
  "codex-integrity",
  "discord",
  "peer",
  "cc",
  "qmd",
]) {
  test(`current-host artifact admission: ${failure ?? "matching"}`, () => {
    const a = structuredClone(actual),
      h = structuredClone(host),
      p = structuredClone(plugins);
    if (failure === "public-version-only") a.build.commit = "f".repeat(40);
    if (failure === "old-lock") h.packages["node_modules/openclaw"].version = "2026.9.6";
    if (failure === "archive") a.hostIntegrity = "different";
    if (failure === "codex-integrity") a.codexIntegrity = "different";
    if (failure === "discord") p.packages["node_modules/@openclaw/discord"] = {};
    if (failure === "peer") p.packages["node_modules/openclaw"].resolved = "/registry-host";
    if (failure === "cc") a.ccSha256 = "0".repeat(64);
    if (failure === "qmd") a.qmdSha256 = "0".repeat(64);
    if (failure) assert.throws(() => validateCurrentHostRecords(candidate, h, p, a));
    else assert.equal(validateCurrentHostRecords(candidate, h, p, a), candidate);
  });
}
test("paired-Life selects its own input directory without changing Code", () => {
  assert.deepEqual(runtimeSelectionPaths(), {
    candidate: "downstream/runtime-install/current-life/candidate.json",
    inputRoot: "downstream/runtime-install/current-life",
    target: "runtime",
  });
  assert.equal(runtimeSelectionPaths("code").inputRoot, "downstream/runtime-install/current-code");
});

for (const [name, mutate] of Object.entries({
  role: (c) => (c.role = "unknown"),
  version: (c) => (c.hostVersion = "2026.9.8"),
  source: (c) => (c.hostProducedFrom = "0".repeat(40)),
  ccSource: (c) => (c.commandCenter.sourceCommit = "0".repeat(40)),
  ccArchive: (c) => (c.commandCenter.archiveSha256 = "0".repeat(64)),
  ccReceipt: (c) => (c.commandCenter.receiptSha256 = "0".repeat(64)),
  ccBuild: (c) => (c.commandCenter.buildDigest = "0".repeat(64)),
  ccArtifact: (c) => (c.commandCenter.artifact = {}),
  ccCarrier: (c) => (c.commandCenter.carrierImage = "unbound"),
  extraComponent: (c) => (c.components.discord = {}),
  qmd: (c) => (c.components.qmd.sha256 = "0".repeat(64)),
  oldQmdArchive: (c) =>
    (c.components.qmd.sha256 = "4162fcc8812d44246065d121a339554419b55aeb4358fc61ca4acbda753bf28a"),
  qmdRootLock: (c) => (c.locks["qmd.package-lock.json"] = "0".repeat(64)),
  registry: (c) => c.companionArtifact.id++,
  platformBinary: (c) => (c.codexPlatform.binarySha256 = "0".repeat(64)),
  lock: (c) => (c.locks["plugins.package-lock.json"] = "0".repeat(64)),
}))
  test(`paired-Life rejects mixed or unsealed ${name}`, () => {
    const c = structuredClone(candidate);
    mutate(c);
    assert.throws(() => validatePairedLifeSelection(c));
  });

const qmdBytes = await readFile(
  new URL("../runtime-install/current-life/qmd.package.json", import.meta.url),
);
const qmdLockBytes = await readFile(
  new URL("../runtime-install/current-life/qmd.package-lock.json", import.meta.url),
);
test("QMD retained wrapper and root lock admit the exact repaired closure", () => {
  assert.equal(validateQmdRuntimeRecords(candidate, qmdBytes, qmdLockBytes).lockfileVersion, 3);
});
for (const name of ["wrapper", "lock", "archive"])
  test("QMD rejects " + name + " mismatch before installation", () => {
    assert.throws(() =>
      validateQmdRuntimeRecords(
        candidate,
        name === "wrapper" ? Buffer.from("{}") : qmdBytes,
        name === "lock" ? Buffer.from("{}") : qmdLockBytes,
        name === "archive" ? "sha512-old" : QMD_SELECTION.integrity,
      ),
    );
  });

for (const failure of [null, "missing", "old-version", "missing-root-lock"])
  test("installed QMD closure: " + (failure ?? "matching"), async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qmd-closure-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "package.json"), qmdBytes);
    await writeFile(path.join(root, "package-lock.json"), qmdLockBytes);
    const lock = JSON.parse(qmdLockBytes);
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (
        !Object.keys(QMD_SELECTION.versions).some(
          (name) => key.endsWith("/node_modules/" + name) || key === "node_modules/" + name,
        )
      )
        continue;
      await mkdir(path.join(root, key), { recursive: true });
      if (failure === "missing" && key.endsWith("/simple-git")) continue;
      await writeFile(
        path.join(root, key, "package.json"),
        JSON.stringify({
          version:
            failure === "old-version" && key.endsWith("/simple-git") ? "3.36.0" : entry.version,
        }),
      );
    }
    if (failure === "missing-root-lock") await rm(path.join(root, "package-lock.json"));
    if (failure) await assert.rejects(validateInstalledQmdRuntime(root, candidate));
    else await validateInstalledQmdRuntime(root, candidate);
  });

const smokeSource = await readFile(new URL("./smoke-image-runtime.mjs", import.meta.url), "utf8");
const sshStart = smokeSource.indexOf("// SSH_PREFLIGHT_START");
const sshEnd = smokeSource.indexOf("// SSH_PREFLIGHT_END");
assert(sshStart >= 0 && sshEnd > sshStart);
const sshEntry = smokeSource.slice(sshStart, sshEnd) + "\nverifySshRuntime();";
for (const failure of [null, "missing", "unsafe", "symlink", "version", "config", "options", "uid"])
  test("actual SSH smoke preflight: " + (failure ?? "matching"), async () => {
    const calls = [],
      receipts = [];
    const context = vm.createContext({
      process: { getuid: () => (failure === "uid" ? 0 : 1000), getgid: () => 1000 },
      lstat: async () => {
        if (failure === "missing") throw new Error("ENOENT");
        return {
          isFile: () => failure !== "symlink",
          uid: 0,
          nlink: 1,
          mode: failure === "unsafe" ? 0o777 : 0o755,
          size: 42,
        };
      },
      realpath: async () => "/usr/bin/ssh",
      readFile: async () => Buffer.from("fictional-ssh"),
      createHash,
      console: { log: (line) => receipts.push(JSON.parse(line)) },
      spawnSync: (binary, args, options) => {
        calls.push({ binary, args, options });
        if (args[0] === "-V")
          return { status: failure === "version" ? 1 : 0, stderr: "OpenSSH_fixture", stdout: "" };
        return {
          status: failure === "config" ? 1 : 0,
          stdout:
            "batchmode yes\nstricthostkeychecking true\nidentitiesonly yes\npasswordauthentication no\nkbdinteractiveauthentication no\nforwardagent no\npermitlocalcommand no\nhostname 127.0.0.1\nport " +
            (failure === "options" ? "22" : "2222") +
            "\n",
        };
      },
    });
    const run = vm.runInContext(sshEntry, context);
    if (failure) await assert.rejects(run);
    else {
      await run;
      assert.equal(receipts[0].serverContacted, false);
      assert.equal(receipts[0].credentialsUsed, false);
      assert.equal(calls.length, 2);
      assert(calls[1].args.includes("-G"));
      assert(calls[1].args.includes("-oStrictHostKeyChecking=yes"));
      assert(calls[1].args.includes("-oBatchMode=yes"));
    }
    if (["missing", "unsafe", "symlink", "uid"].includes(failure)) assert.equal(calls.length, 0);
  });
