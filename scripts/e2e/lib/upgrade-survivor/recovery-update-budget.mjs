// Recovery sampling shares the enclosing update command's deadline contract.
import { pathToFileURL } from "node:url";
import { parseTimeoutMs } from "../../../lib/docker-e2e-watchdog.mjs";

const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

export function resolveRecoveryUpdateBudget(timeoutValue, env = process.env) {
  const commandMs = parseTimeoutMs(timeoutValue);
  if (
    Number.parseFloat(String(timeoutValue)) <= 0 ||
    !Number.isSafeInteger(commandMs) ||
    commandMs > MAX_TIMER_TIMEOUT_MS
  ) {
    throw new Error("recovery command timeout must be positive and within the sampler timer bound");
  }
  const readBudget = (name, fallback) => {
    const text = String(env[name] ?? fallback).trim();
    const value = Number(text);
    if (!/^\d+$/u.test(text) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer; got: ${text}`);
    }
    return Math.min(value, commandMs);
  };
  const phaseMs = readBudget("OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS", commandMs);
  const wallMs = readBudget("OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS", phaseMs);
  return { phaseMs, wallMs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { phaseMs, wallMs } = resolveRecoveryUpdateBudget(process.argv[2]);
    process.stdout.write(`${phaseMs} ${wallMs}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
