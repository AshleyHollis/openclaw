import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const expectedOpenClawVersion = process.env.EXPECTED_OPENCLAW_VERSION;
const expectedCodexVersion = process.env.EXPECTED_CODEX_VERSION;
const expectedQmdVersion = process.env.EXPECTED_QMD_VERSION;
if (!expectedOpenClawVersion || !expectedCodexVersion || !expectedQmdVersion) {
  throw new Error("expected OpenClaw, Codex, and QMD versions are required");
}

const imagePluginRuntimeRoot = "/opt/openclaw-plugin-runtime";
const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-image-smoke-"));
const stateDir = path.join(root, "state");
const managedPluginRuntimeRoot = path.join(stateDir, "npm");
const managedPluginPath = path.join(
  managedPluginRuntimeRoot,
  "node_modules/@openclaw/codex",
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
  await mkdir(stateDir, { recursive: true });
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
          allow: ["codex"],
          entries: { codex: { enabled: true } },
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

  const qmd = spawnSync("qmd", ["--version"], { encoding: "utf8", env: environment });
  if (qmd.status !== 0 || !qmd.stdout.includes(`qmd ${expectedQmdVersion}`)) {
    throw new Error(`unexpected QMD version: ${(qmd.stdout || qmd.stderr).trim()}`);
  }
  const qmdRoot = "/opt/qmd-runtime/node_modules/@tobilu/qmd";
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
  console.log("Exact image, baked Codex plugin, QMD runtime, and scoped loopback RPC passed");
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

async function validateAndHydrateImagePluginRuntime() {
  const imagePluginPath = path.join(imagePluginRuntimeRoot, "node_modules/@openclaw/codex");
  const [manifest, shrinkwrap] = await Promise.all(
    ["package.json", "npm-shrinkwrap.json"].map(async (fileName) =>
      JSON.parse(await readFile(path.join(imagePluginPath, fileName), "utf8")),
    ),
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
  await cp(imagePluginRuntimeRoot, managedPluginRuntimeRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await symlink("/app/node_modules/openclaw", managedHostPeerPath, "dir");
  const rootManifestPath = path.join(managedPluginRuntimeRoot, "package.json");
  const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8"));
  rootManifest.dependencies = {
    ...(rootManifest.dependencies ?? {}),
    "@openclaw/codex": manifest.version,
  };
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
  if (/(\[plugins\].*(failed|error)|codex.*(failed|error)|TypeError:.*openSyncKeyedStore)/iu.test(output)) {
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
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
