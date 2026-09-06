import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Run actual native publication/faults in one owned process; filesystem fault
// injection must never change the shared Vitest worker's fs/config state.
it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "preserves scoped staging, strict durability and existing caller contracts",
  () => {
    const fixture = fileURLToPath(
      new URL("../fixtures/fs-safe-scoped-staging.mjs", import.meta.url),
    );
    const child = spawnSync(process.execPath, ["--test-reporter=tap", fixture], {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stdout).toContain("# tests 9");
    expect(child.stdout).toContain("# pass 9");
    expect(child.stdout).toContain("# skipped 0");
  },
  35_000,
);
