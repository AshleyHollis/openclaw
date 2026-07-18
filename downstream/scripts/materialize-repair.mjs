#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import process from "node:process";

const allowedPath = /^(?:src|extensions|test)\//u;
const forbiddenPath = /(?:^|\/)(?:package\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|package-lock\.json|Dockerfile[^/]*)$/u;

function runGit(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

const raw = process.env.CODEX_REPAIR_JSON;
if (!raw) {
  throw new Error("CODEX_REPAIR_JSON is required");
}
const repair = JSON.parse(raw);
if (typeof repair.summary !== "string" || typeof repair.patch !== "string") {
  throw new Error("Codex repair must contain string summary and patch fields");
}
if (repair.patch.length === 0 || repair.patch.length > 900_000) {
  throw new Error("Codex repair patch is empty or exceeds 900 KB");
}

const normalizedPatch = repair.patch.endsWith("\n") ? repair.patch : `${repair.patch}\n`;
await writeFile("codex-repair.patch", normalizedPatch, "utf8");
runGit(["apply", "--check", "--whitespace=error-all", "codex-repair.patch"]);
runGit(["apply", "--whitespace=error-all", "codex-repair.patch"]);
const changed = runGit(["diff", "--name-only", "--diff-filter=ACMRT"])
  .split("\n")
  .filter(Boolean);
if (changed.length === 0) {
  throw new Error("Codex repair produced no changed files");
}
for (const file of changed) {
  if (!allowedPath.test(file) || forbiddenPath.test(file)) {
    throw new Error(`Codex repair touched forbidden path: ${file}`);
  }
}
console.log(JSON.stringify({ changed, summary: repair.summary }, null, 2));
