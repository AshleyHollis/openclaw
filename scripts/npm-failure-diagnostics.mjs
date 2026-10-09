import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// npm debug logs can contain registry credentials, configuration and private paths.
// Publish only typed versions, timer names and stack locations, never raw records.
export function summarizeNpmFailureLog(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    let match = line.match(/^\d+ (?:info|verbose) (node|npm)\s+(v?\d+\.\d+\.\d+)$/);
    if (match) {
      records.push({ kind: "version", tool: match[1], version: match[2] });
      continue;
    }
    match = line.match(/^\d+ verbose unfinished npm timer ([A-Za-z0-9:_-]+) (\d+)$/);
    if (match) {
      records.push({ kind: "unfinished-timer", timer: match[1] });
      continue;
    }
    match = line.match(/^\d+ timing ([A-Za-z0-9:_-]+) Completed in (\d+)ms$/);
    if (match) {
      records.push({ kind: "timing", timer: match[1], milliseconds: Number(match[2]) });
      continue;
    }
    match = line.match(/^\d+ error code (E[A-Z0-9_]+)$/);
    if (match) {
      records.push({ kind: "error-code", code: match[1] });
      continue;
    }
    match = line.match(
      /^\d+ verbose stack\s+at ([A-Za-z0-9_.$<>]+) \(.*\/([A-Za-z0-9_.-]+\.[cm]?js):(\d+):(\d+)\)$/,
    );
    if (match) {
      records.push({
        kind: "stack-location",
        function: match[1],
        file: match[2],
        line: Number(match[3]),
        column: Number(match[4]),
      });
    }
  }
  return records;
}

export function collectNpmFailureDiagnostics(logsDir) {
  if (!fs.existsSync(logsDir)) {
    return [];
  }
  return fs
    .readdirSync(logsDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}T[\d_.Z-]+-debug-\d+\.log$/.test(name))
    .sort()
    .reverse()
    .slice(0, 3)
    .flatMap((name) => {
      const file = path.join(logsDir, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) {
        return [];
      }
      return summarizeNpmFailureLog(fs.readFileSync(file, "utf8"));
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== "--logs-dir") {
    console.error(JSON.stringify({ npmFailureDiagnosticsUnavailable: true }));
    process.exitCode = 1;
  } else {
    try {
      console.error(
        JSON.stringify({ npmFailureDiagnostics: collectNpmFailureDiagnostics(process.argv[3]) }),
      );
    } catch {
      // Files may disappear or become unreadable during failure cleanup. Never
      // let a native filesystem error expose the private path through its stack.
      console.error(JSON.stringify({ npmFailureDiagnosticsUnavailable: true }));
      process.exitCode = 1;
    }
  }
}
