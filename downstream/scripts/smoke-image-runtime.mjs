import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const expectedOpenClawVersion = process.env.EXPECTED_OPENCLAW_VERSION;
const expectedCodexVersion = process.env.EXPECTED_CODEX_VERSION;
if (!expectedOpenClawVersion || !expectedCodexVersion) {
  throw new Error("expected OpenClaw and Codex versions are required");
}

const pluginPath = "/opt/openclaw-plugin-runtime/node_modules/@openclaw/codex";
const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-image-smoke-"));
const stateDir = path.join(root, "state");
const configPath = path.join(stateDir, "openclaw.json");
const gatewayLog = path.join(root, "gateway.log");
const environment = {
  ...process.env,
  HOME: path.join(root, "home"),
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_STATE_DIR: stateDir,
};

let gateway;
let gatewayLogFd;
try {
  await mkdir(environment.HOME, { recursive: true });
  await mkdir(stateDir, { recursive: true });
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
          load: { paths: [pluginPath] },
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

  const inspected = runOpenClaw(["plugins", "inspect", "codex", "--json"], environment);
  const inspection = JSON.parse(inspected.stdout);
  if (inspection.plugin?.status !== "loaded") {
    throw new Error(`Codex plugin status is ${inspection.plugin?.status ?? "missing"}`);
  }
  if (inspection.plugin?.version !== expectedCodexVersion) {
    throw new Error(`unexpected Codex version: ${inspection.plugin?.version ?? "missing"}`);
  }
  if (inspection.plugin?.rootDir !== pluginPath) {
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
  for (let attempt = 0; attempt < 40; attempt += 1) {
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
    throw new Error(`scoped loopback RPC failed: ${redact(lastRpcError)}\n${redact(log)}`);
  }
  console.log("Exact image, baked Codex plugin, and scoped loopback RPC passed");
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
