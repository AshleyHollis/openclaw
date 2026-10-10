import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const codeProfile = process.env.RUNTIME_PROFILE === "code";
if (![undefined, "paired-life", "code"].includes(process.env.RUNTIME_PROFILE)) throw new Error("unknown smoke runtime profile");
const expectedOpenClawVersion = process.env.EXPECTED_OPENCLAW_VERSION;
const expectedCodexVersion = process.env.EXPECTED_CODEX_VERSION;
// Preserve the historical July invocation; modern images require an explicit
// selection at their image-owned validation boundary below.
const expectedDiscordVersion = process.env.EXPECTED_DISCORD_VERSION ?? "2026.7.1";
const includeDiscord = expectedDiscordVersion !== "absent";
const expectedQmdVersion = process.env.EXPECTED_QMD_VERSION;
if (
  !expectedOpenClawVersion ||
  !expectedCodexVersion ||
  !expectedDiscordVersion ||
  !expectedQmdVersion
) {
  throw new Error("expected OpenClaw, Codex, Discord, and QMD versions are required");
}

if (codeProfile && (expectedOpenClawVersion !== "2026.9.9" || expectedCodexVersion !== "2026.9.9" || expectedQmdVersion !== "absent" || includeDiscord)) throw new Error("Code smoke selection differs");
if (!codeProfile && expectedQmdVersion === "absent") throw new Error("paired smoke requires QMD");
const imagePluginRuntimeRoot = "/opt/openclaw-plugin-runtime";
const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-image-smoke-"));
const stateDir = path.join(root, "state");
const managedPluginRuntimeRoot = path.join(stateDir, "npm");
const managedPluginPath = path.join(managedPluginRuntimeRoot, "node_modules/@openclaw/codex");
const managedDiscordPluginPath = path.join(
  managedPluginRuntimeRoot,
  "node_modules/@openclaw/discord",
);
const managedHostPeerPath = path.join(managedPluginPath, "node_modules/openclaw");
const configPath = path.join(stateDir, "openclaw.json");
const gatewayLog = path.join(root, "gateway.log");
const environment = {
  ...process.env,
  HOME: path.join(root, "home"),
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_DEBUG: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_STATE_DIR: stateDir,
};

let gateway;
let gatewayLogFd;
try {
  await mkdir(environment.HOME, { recursive: true });
  await mkdir(path.join(environment.HOME, ".config/chromium/Crash Reports/pending"), {
    recursive: true,
  });
  await mkdir(stateDir, { recursive: true });
  if (!includeDiscord) await verifySshRuntime();
  await validateAndHydrateImagePluginRuntime();
  const port = await reserveLoopbackPort();
  const token = randomBytes(32).toString("hex");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        gateway: {
          mode: "local",
          bind: "loopback",
          port,
          auth: { mode: "token", token },
        },
        plugins: {
          allow: codeProfile ? ["codex", "openai", "workboard"] : includeDiscord ? ["codex", "discord"] : ["codex"],
          entries: { ...(codeProfile ? { openai: { enabled: true }, workboard: { enabled: true } } : {}), codex: { enabled: true }, ...(includeDiscord ? { discord: { enabled: true } } : {}) },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const version = runOpenClaw(["--version"], environment).stdout;
  if (!version.includes(expectedOpenClawVersion)) {
    throw new Error(`unexpected OpenClaw version: ${version.trim()}`);
  }

  if (!codeProfile) {
  const qmd = spawnSync("qmd", ["--version"], { encoding: "utf8", env: environment });
  if (qmd.status !== 0 || !qmd.stdout.includes(`qmd ${expectedQmdVersion}`)) {
    throw new Error(`unexpected QMD version: ${(qmd.stdout || qmd.stderr).trim()}`);
  }
  const qmdStatus = spawnSync("qmd", ["status"], { encoding: "utf8", env: environment });
  if (qmdStatus.status !== 0) {
    throw new Error(
      `QMD failed to open its database runtime: ${(qmdStatus.stdout || qmdStatus.stderr).trim()}`,
    );
  }
  }
  if (!codeProfile && !includeDiscord) {
    const fixture = path.join(root, "qmd-lexical-fixture");
    await mkdir(fixture);
    await writeFile(path.join(fixture, "packaging-canary.md"), "Packagingcanary validates local lexical retrieval.\n");
    for (const args of [["collection", "add", fixture, "--name", "packaging-smoke", "--mask", "*.md"], ["update"], ["search", "packagingcanary", "--json"]]) {
      const result = spawnSync("qmd", args, { encoding: "utf8", env: environment, timeout: 60000, maxBuffer: 1024 * 1024 });
      if (result.status !== 0) throw new Error("QMD lexical smoke command failed: " + args[0]);
      if (args[0] === "search" && !JSON.stringify(JSON.parse(result.stdout)).includes("packaging-canary.md")) throw new Error("QMD lexical fixture not retrieved");
    }
  }
  const pythonRequests = spawnSync("python3", ["-c", "import requests"], {
    encoding: "utf8",
    env: environment,
  });
  if (pythonRequests.status !== 0) {
    throw new Error(`Python requests import failed: ${pythonRequests.stderr.trim()}`);
  }
  const npm = spawnSync("npm", ["--version"], {
    encoding: "utf8",
    env: environment,
  });
  if (npm.status !== 0 || npm.stdout.trim() !== "12.0.1") {
    throw new Error(`unexpected npm runtime: ${(npm.stdout || npm.stderr).trim()}`);
  }
  const npmTar = JSON.parse(
    await readFile("/usr/local/lib/node_modules/npm/node_modules/tar/package.json", "utf8"),
  );
  if (npmTar.version !== "7.5.19") {
    throw new Error(`vulnerable npm tar runtime: ${npmTar.version}`);
  }
  const chromium = spawnSync("chromium", ["--version"], {
    encoding: "utf8",
    env: environment,
  });
  if (chromium.status !== 0 || !chromium.stdout.includes("Chromium")) {
    throw new Error(
      `Chromium runtime is unavailable: ${(chromium.stdout || chromium.stderr).trim()}`,
    );
  }
  const chromiumLaunch = spawnSync(
    "chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--user-data-dir=${path.join(root, "chromium")}`,
      "--dump-dom",
      "data:text/html,%3Ctitle%3EOpenClawBrowserSmoke%3C/title%3E",
    ],
    { encoding: "utf8", env: environment },
  );
  if (
    chromiumLaunch.status !== 0 ||
    !chromiumLaunch.stdout.includes("<title>OpenClawBrowserSmoke</title>")
  ) {
    throw new Error(`Chromium headless launch failed: ${chromiumLaunch.stderr.trim()}`);
  }
  if (!codeProfile) {
  const qmdRoot = "/opt/qmd-runtime/node_modules/@tobilu/qmd";
  if (!includeDiscord) {
    const { validateInstalledQmdRuntime } = await import("/opt/openclaw-runtime/validate-current-host-image-inputs.mjs");
    const candidate = JSON.parse(await readFile("/opt/openclaw-runtime/candidate.json", "utf8"));
    await validateInstalledQmdRuntime("/opt/qmd-runtime", candidate);
  }
  const qmdManifest = JSON.parse(await readFile(path.join(qmdRoot, "package.json"), "utf8"));
  const qmdShrinkwrap = JSON.parse(
    await readFile(path.join(qmdRoot, "npm-shrinkwrap.json"), "utf8"),
  );
  if (
    qmdManifest.name !== "@tobilu/qmd" ||
    qmdManifest.version !== expectedQmdVersion ||
    qmdShrinkwrap.name !== qmdManifest.name ||
    qmdShrinkwrap.version !== qmdManifest.version ||
    qmdShrinkwrap.packages?.[""]?.version !== qmdManifest.version
  ) {
    throw new Error("QMD image runtime metadata disagrees");
  }

  }

  const inspected = runOpenClaw(["plugins", "inspect", "codex", "--json"], environment);
  const inspection = JSON.parse(inspected.stdout);
  if (inspection.plugin?.status !== "loaded") {
    throw new Error(`Codex plugin status is ${inspection.plugin?.status ?? "missing"}`);
  }
  if (inspection.plugin?.version !== expectedCodexVersion) {
    throw new Error(`unexpected Codex version: ${inspection.plugin?.version ?? "missing"}`);
  }
  if (inspection.plugin?.rootDir !== managedPluginPath) {
    throw new Error(`Codex plugin loaded from unexpected path: ${inspection.plugin?.rootDir}`);
  }
  if (inspection.plugin?.dependencyStatus?.requiredInstalled !== true) {
    throw new Error("Codex plugin runtime dependencies are incomplete");
  }

  if (codeProfile) {
    for (const id of ["openai", "workboard"]) {
      const inspection = JSON.parse(runOpenClaw(["plugins", "inspect", id, "--json"], environment).stdout);
      if (inspection.plugin?.status !== "loaded") throw new Error(`Code ${id} plugin is not loaded`);
      if (!inspection.plugin.rootDir?.startsWith("/app/node_modules/openclaw/")) throw new Error(`Code ${id} plugin is outside the frozen host`);
    }
  }
  if (includeDiscord) {
  const discordInspected = runOpenClaw(["plugins", "inspect", "discord", "--json"], environment);
  const discordInspection = JSON.parse(discordInspected.stdout);
  if (discordInspection.plugin?.status !== "loaded") {
    throw new Error(`Discord plugin status is ${discordInspection.plugin?.status ?? "missing"}`);
  }
  if (discordInspection.plugin?.version !== expectedDiscordVersion) {
    throw new Error(
      `unexpected Discord version: ${discordInspection.plugin?.version ?? "missing"}`,
    );
  }
  if (discordInspection.plugin?.rootDir !== managedDiscordPluginPath) {
    throw new Error(
      `Discord plugin loaded from unexpected path: ${discordInspection.plugin?.rootDir}`,
    );
  }
  if (!discordInspection.plugin?.channelIds?.includes("discord")) {
    throw new Error("Discord plugin did not register the Discord channel");
  }

  }

  const metadata = spawnSync("openclaw", ["export"], {
    encoding: "utf8",
    env: environment,
  });
  assertNoPluginLoadError(`${metadata.stdout ?? ""}\n${metadata.stderr ?? ""}`);

  gatewayLogFd = openSync(gatewayLog, "a", 0o600);
  gateway = spawn(
    "openclaw",
    ["gateway", "run", "--bind", "loopback", "--port", String(port), "--token", token],
    { env: environment, stdio: ["ignore", gatewayLogFd, gatewayLogFd] },
  );

  let rpcPassed = false;
  let lastRpcError = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const rpc = spawnSync(
      "openclaw",
      ["cron", "status", "--json", "--url", `ws://127.0.0.1:${port}`, "--token", token],
      { encoding: "utf8", env: environment },
    );
    if (rpc.status === 0) {
      rpcPassed = true;
      break;
    }
    lastRpcError = rpc.stderr ?? "";
    if (gateway.exitCode !== null) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const log = await readFile(gatewayLog, "utf8");
  assertNoPluginLoadError(log);
  if (!rpcPassed) {
    throw new Error(
      `scoped loopback RPC failed (gateway exit=${String(gateway.exitCode)}, signal=${String(gateway.signalCode)}): ${redact(lastRpcError)}\n${redact(log)}`,
    );
  }
  console.log("Exact selected image, baked plugins, selected tools, and scoped loopback RPC passed");
} finally {
  if (gateway?.exitCode === null) {
    gateway.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => gateway.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (gateway.exitCode === null) {
      gateway.kill("SIGKILL");
    }
  }
  if (gatewayLogFd !== undefined) {
    closeSync(gatewayLogFd);
  }
  await rm(root, { recursive: true, force: true });
}

// SSH_PREFLIGHT_START
async function verifySshRuntime() {
  if (process.getuid?.() !== 1000 || process.getgid?.() !== 1000)
    throw new Error("SSH smoke requires runtime UID/GID 1000");
  const binary = "/usr/bin/ssh";
  const stat = await lstat(binary);
  if (
    !stat.isFile() ||
    stat.uid !== 0 ||
    stat.nlink !== 1 ||
    (stat.mode & 0o7777) !== 0o755 ||
    stat.size > 16 * 1024 * 1024 ||
    (await realpath(binary)) !== binary
  )
    throw new Error("SSH binary physical identity differs");
  const env = { HOME: "/nonexistent", PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  const version = spawnSync(binary, ["-V"], {
    encoding: "utf8",
    env,
    timeout: 10000,
    maxBuffer: 65536,
  });
  if (
    version.status !== 0 ||
    !((version.stderr || "") + (version.stdout || "")).includes("OpenSSH_")
  )
    throw new Error("SSH version preflight failed");
  const options = [
    "-F",
    "/dev/null",
    "-G",
    "-T",
    "-n",
    "-p",
    "2222",
    "-i",
    "/dev/null",
    "-oBatchMode=yes",
    "-oIdentitiesOnly=yes",
    "-oIdentityAgent=none",
    "-oPreferredAuthentications=publickey",
    "-oPasswordAuthentication=no",
    "-oKbdInteractiveAuthentication=no",
    "-oStrictHostKeyChecking=yes",
    "-oHostKeyAlgorithms=ssh-ed25519",
    "-oPubkeyAcceptedAlgorithms=ssh-ed25519",
    "-oUserKnownHostsFile=/dev/null",
    "-oGlobalKnownHostsFile=/dev/null",
    "-oUpdateHostKeys=no",
    "-oForwardAgent=no",
    "-oClearAllForwardings=yes",
    "-oRequestTTY=no",
    "-oPermitLocalCommand=no",
    "-oProxyCommand=none",
    "-oProxyJump=none",
    "-oControlMaster=no",
    "-oControlPath=none",
    "-oCanonicalizeHostname=no",
    "-oConnectionAttempts=1",
    "-oConnectTimeout=5",
    "codex@127.0.0.1",
  ];
  const config = spawnSync(binary, options, {
    encoding: "utf8",
    env,
    timeout: 10000,
    maxBuffer: 65536,
  });
  if (config.status !== 0) throw new Error("SSH config-only preflight failed");
  const fields = new Map(
    config.stdout
      .trim()
      .split(/\r?\n/u)
      .map((line) => {
        const at = line.indexOf(" ");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  for (const [name, expected] of [
    ["batchmode", "yes"],
    ["stricthostkeychecking", "true"],
    ["identitiesonly", "yes"],
    ["passwordauthentication", "no"],
    ["kbdinteractiveauthentication", "no"],
    ["forwardagent", "no"],
    ["permitlocalcommand", "no"],
    ["hostname", "127.0.0.1"],
    ["port", "2222"],
  ]) {
    if (fields.get(name) !== expected) throw new Error("SSH effective config differs: " + name);
  }
  console.log(
    JSON.stringify({
      sshPhysicalVerified: true,
      sshConfigOnlyVerified: true,
      sshSha256: createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
      serverContacted: false,
      credentialsUsed: false,
    }),
  );
}
// SSH_PREFLIGHT_END

async function validateAndHydrateImagePluginRuntime() {
  const imagePluginPath = path.join(imagePluginRuntimeRoot, "node_modules/@openclaw/codex");
  const manifest = JSON.parse(await readFile(path.join(imagePluginPath, "package.json"), "utf8"));
  const packagedValidator = "/opt/openclaw-runtime/validate-plugin-runtime.mjs";
  const modern = await lstat(packagedValidator).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (modern) {
    if (!process.env.EXPECTED_DISCORD_VERSION) {
      throw new Error("packaged runtime requires an explicit Discord version");
    }
    const { validateInstalledPluginRuntime } = await import(packagedValidator);
    const candidate = JSON.parse(await readFile("/opt/openclaw-runtime/candidate.json", "utf8"));
    if (codeProfile && candidate.role !== "code") throw new Error("Code smoke requires Code image selection");
    if (!codeProfile && candidate.role === "code") throw new Error("paired smoke cannot validate Code image");
    await validateInstalledPluginRuntime(imagePluginRuntimeRoot, undefined, candidate);
  } else {
    const shrinkwrap = JSON.parse(
      await readFile(path.join(imagePluginPath, "npm-shrinkwrap.json"), "utf8"),
    );
    if (
      manifest.name !== "@openclaw/codex" ||
      manifest.version !== expectedCodexVersion ||
      shrinkwrap.name !== manifest.name ||
      shrinkwrap.version !== manifest.version ||
      shrinkwrap.packages?.[""]?.version !== manifest.version
    ) {
      throw new Error("image Codex package and shrinkwrap metadata disagree");
    }
  }
  if (manifest.name !== "@openclaw/codex" || manifest.version !== expectedCodexVersion)
    throw new Error("image Codex version differs");
  await cp(imagePluginRuntimeRoot, managedPluginRuntimeRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const hostPeerMetadata = await lstat(managedHostPeerPath);
  if (!hostPeerMetadata.isSymbolicLink()) {
    throw new Error("Codex host peer is not an image-owned symbolic link");
  }
  if ((await readlink(managedHostPeerPath)) !== "/app/node_modules/openclaw") {
    throw new Error("Codex host peer points outside the packaged OpenClaw runtime");
  }
  const rootManifestPath = path.join(managedPluginRuntimeRoot, "package.json");
  const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8"));
  if (includeDiscord) {
    const discordManifest = JSON.parse(await readFile(path.join(managedDiscordPluginPath, "package.json"), "utf8"));
    if (discordManifest.name !== "@openclaw/discord" || discordManifest.version !== expectedDiscordVersion) {
      throw new Error("image Discord package metadata disagrees");
    }
    rootManifest.dependencies = { ...(rootManifest.dependencies ?? {}), "@openclaw/discord": discordManifest.version };
  } else {
    const discord = await lstat(managedDiscordPluginPath).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (discord || rootManifest.dependencies?.["@openclaw/discord"]) throw new Error("unused Discord remains in the image-owned runtime");
  }
  rootManifest.dependencies = { ...(rootManifest.dependencies ?? {}), "@openclaw/codex": manifest.version };
  await writeFile(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

function runOpenClaw(args, env) {
  const result = spawnSync("openclaw", args, { encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(`openclaw ${args.join(" ")} failed: ${redact(result.stderr ?? "")}`);
  }
  return result;
}

function assertNoPluginLoadError(output) {
  if (
    /(\[plugins\].*(failed|error)|codex.*(failed|error)|TypeError:.*openSyncKeyedStore)/iu.test(
      output,
    )
  ) {
    throw new Error(`Codex plugin registration failed: ${redact(output)}`);
  }
}

function redact(value) {
  return value.replace(/[0-9a-f]{64}/giu, "<redacted-token>");
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to reserve a loopback port");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
