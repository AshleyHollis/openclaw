import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  resolveBuildAllStep,
  resolveBuildAllSteps,
  runBuildAllSteps,
} from "../../scripts/build-all.mts";
import * as liveGatewayDistFence from "../../scripts/lib/live-gateway-dist-fence.mts";
import * as managedChildProcess from "../../scripts/lib/managed-child-process.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

beforeEach(() => {
  const fence = vi
    .spyOn(liveGatewayDistFence, "resolveLiveManagedGatewayDistFence")
    .mockResolvedValue({ refuse: false });
  onTestFinished(() => fence.mockRestore());
});

vi.mock("../../src/cli/update-cli/update-command-service-publication.js", () => ({
  withGatewayRuntimeArtifactPublication: async (
    _params: unknown,
    publish: () => Promise<unknown>,
  ) => publish(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function buildMemoryLimit(cgroupGiB: number) {
  // A cgroup-only fixture still reads Linux MemAvailable. Pin the host facts so
  // concurrent CI work cannot change the admission this scenario exercises.
  return {
    platform: "linux",
    availableMemoryBytes: 16 * 1024 ** 3,
    procMemTotalBytes: 16 * 1024 ** 3,
    cgroupMemoryLimitBytes: cgroupGiB * 1024 ** 3,
  };
}

function writeFixture(root: string, file: string, contents: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

describe("SDK smoke generated asset preparation", () => {
  it("prepares generated plugin manifests before SDK smoke compiler inputs are sealed", () => {
    const steps = resolveBuildAllSteps("pluginSdkStrictSmoke", {});
    expect(steps[0]?.label).toBe("plugins:assets:build");
    expect(
      resolveBuildAllStep(expectDefined(steps[0], "asset preparation"), {
        env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
        deferIsolatedAssets: true,
      }).args,
    ).toEqual([
      "--import",
      "tsx",
      "scripts/bundled-plugin-assets.mts",
      "--phase",
      "build",
      "--defer-isolated",
    ]);
  });

  it.each(["generated", "authored", "edit-and-revert", "late-generated"])(
    "keeps SDK smoke stamp validation across %s manifest preparation",
    async (change) => {
      const cwd = tempDirs.make("openclaw-sdk-smoke-inputs-");
      writeFixture(cwd, ".gitignore", "dist/\n");
      writeFixture(cwd, "package.json", '{"private":true}\n');
      const source = writeFixture(cwd, "src/example.ts", "export const value = 1;\n");
      writeFixture(
        cwd,
        "extensions/fixture/package.json",
        JSON.stringify({
          name: "fixture",
          openclaw: {
            controlUi: "./browser.ts",
            assetScripts: { build: "fixture-only", buildOutputs: ["openclaw.plugin.json"] },
          },
        }),
      );
      const manifest = writeFixture(
        cwd,
        "extensions/fixture/openclaw.plugin.json",
        JSON.stringify({ id: "fixture", controlUi: { entry: "old.js" } }),
      );
      expect(spawnSync("git", ["init", "--quiet"], { cwd }).status).toBe(0);
      const prepareManifest = (entry = "new.js") => {
        if (JSON.parse(fs.readFileSync(manifest, "utf8")).controlUi.entry === entry) {
          return;
        }
        fs.writeFileSync(
          manifest + ".tmp",
          JSON.stringify({ id: "fixture", controlUi: { entry } }),
        );
        fs.renameSync(manifest + ".tmp", manifest);
      };
      const command = vi
        .spyOn(managedChildProcess, "runManagedCommand")
        .mockImplementation(async ({ args = [] }) => {
          if (args.includes("scripts/bundled-plugin-assets.mts")) {
            prepareManifest();
          }
          if (args.includes("scripts/build-external-plugin-local-dist.mts")) {
            prepareManifest();
            if (change === "authored") {
              fs.writeFileSync(manifest, JSON.stringify({ id: "changed" }));
            } else if (change === "edit-and-revert") {
              const original = fs.readFileSync(source);
              fs.writeFileSync(source, "export const value = 2;\n");
              fs.writeFileSync(source, original);
            } else if (change === "late-generated") {
              prepareManifest("different-late.js");
            }
          }
          return 0;
        });
      onTestFinished(() => command.mockRestore());
      const result = runBuildAllSteps("pluginSdkStrictSmoke", {
        cwd,
        env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1", GIT_COMMIT: "a".repeat(40) },
        cacheEnabled: false,
        resolveCacheState: () => ({ cacheable: false, fresh: false, reason: "no-cache" }),
        finalizeCache: () => true,
        logger: { error: vi.fn(), warn: vi.fn() },
        memoryLimit: buildMemoryLimit(8),
      });
      if (change === "generated") {
        expect((await result).exitCode).toBe(0);
      } else {
        await expect(result).rejects.toThrow("Build inputs changed during preparation");
      }
    },
  );
});
