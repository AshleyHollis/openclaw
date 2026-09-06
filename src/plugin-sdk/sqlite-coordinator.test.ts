import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqliteRuntime from "./sqlite-runtime.js";

describe("plugin SQLite coordinator", () => {
  const dirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

  it("excludes a live process and releases its shared-file lock after process death", async () => {
    expect(sqliteRuntime.tryAcquireExclusiveSqliteCoordinator).toBeTypeOf("function");
    const location = path.join(dirs.make("plugin-coordinator-"), "owner.sqlite");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { DatabaseSync } from 'node:sqlite';
      const database = new DatabaseSync(process.argv[1]);
      database.exec('BEGIN EXCLUSIVE');
      process.send('locked');
      setInterval(() => {}, 1000);
    `,
        location,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true },
    );
    const exited = once(child, "exit");
    let locked = false;
    child.on("message", (message) => {
      locked = message === "locked";
    });
    try {
      await vi.waitFor(() => expect(locked).toBe(true));
      expect(sqliteRuntime.tryAcquireExclusiveSqliteCoordinator(location)).toBeNull();
      child.kill("SIGKILL");
      await exited;
      const recovered = sqliteRuntime.tryAcquireExclusiveSqliteCoordinator(location);
      expect(recovered).not.toBeNull();
      recovered?.release();
      const next = sqliteRuntime.tryAcquireExclusiveSqliteCoordinator(location);
      expect(next).not.toBeNull();
      next?.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await exited;
    }
  });
});
