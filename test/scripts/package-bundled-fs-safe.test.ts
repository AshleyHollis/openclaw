import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  collectPatchedFsSafeArtifactErrors,
  isSupportedPatchedFsSafeVersion,
} from "../../scripts/lib/package-bundled-fs-safe.mts";
import { resolveFsSafePublicationContract } from "../../scripts/resolve-fs-safe-native-contract.mjs";

const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-arm64-musl",
  "linux-x64-gnu",
  "linux-x64-musl",
  "win32-x64-msvc",
];
function errors(version: string, bundledVersion = version, nativeVersion = version) {
  return collectPatchedFsSafeArtifactErrors({
    declaredVersion: version,
    manifest: {
      version: bundledVersion,
      type: "module",
      exports: { "./atomic": { default: "./dist/atomic.js", types: "./dist/atomic.d.ts" } },
      optionalDependencies: Object.fromEntries(
        platforms.map((platform) => [`@openclaw/fs-safe-${platform}`, nativeVersion]),
      ),
    },
    files: new Set(["dist/mutation-authority.js"]),
    // Frozen 0.21.1 authority bytes must not qualify the newer runtime.
    sha256: () => "1bc13e45fd6c27777d0043c73b7652a23a69ad3f2e284eb6cde5c5f376416463",
  });
}

describe("version-bound patched fs-safe runtime", () => {
  it("retains only the explicitly reviewed current and historical versions", () => {
    expect(isSupportedPatchedFsSafeVersion("0.24.2")).toBe(true);
    expect(isSupportedPatchedFsSafeVersion("0.21.1")).toBe(true);
    expect(isSupportedPatchedFsSafeVersion("0.24.3")).toBe(false);
    expect(isSupportedPatchedFsSafeVersion("^0.24.2")).toBe(false);
  });
  it("preserves the historical authority while rejecting it for the current runtime", () => {
    expect(errors("0.21.1")).not.toContain(
      "bundled @openclaw/fs-safe has unpatched or changed runtime entry dist/mutation-authority.js",
    );
    expect(errors("0.24.2")).toContain(
      "bundled @openclaw/fs-safe has unpatched or changed runtime entry dist/mutation-authority.js",
    );
  });
  it("rejects a historical bundle or platform package declared as current", () => {
    expect(errors("0.24.2", "0.21.1")).toContain(
      "bundled @openclaw/fs-safe must be ESM version 0.24.2",
    );
    expect(errors("0.24.2", "0.24.2", "0.21.1")).toContain(
      "bundled @openclaw/fs-safe must retain exact native dependency linux-x64-gnu",
    );
  });
});

describe("source-bound fs-safe publication qualification", () => {
  const selectedSha = "1".repeat(40);
  const workflowSha = "2".repeat(40);
  const patchPath = "patches/@openclaw__fs-safe@0.24.2.patch";
  function resolveContract(
    version: string,
    options: { bundled?: boolean; patch?: string; current?: boolean } = {},
  ) {
    const sources: Record<string, string> = {
      "package.json": JSON.stringify({
        dependencies: { "@openclaw/fs-safe": version },
        ...(options.bundled !== false ? { bundleDependencies: ["@openclaw/fs-safe"] } : {}),
      }),
      "pnpm-workspace.yaml": `patchedDependencies:\n  "@openclaw/fs-safe@0.24.2": ${patchPath}\n`,
      [patchPath]: options.patch ?? (version === "0.24.2" ? readFileSync(patchPath, "utf8") : ""),
    };
    return resolveFsSafePublicationContract({
      selectedSha: options.current ? workflowSha : selectedSha,
      workflowSha,
      allowFrozenSource: true,
      containingBranches: () => ["origin/extended-stable/2026.9.33"],
      readSource: (file: string) => sources[file] ?? null,
    });
  }
  it("requires the reviewed current contract even for a canonical frozen source", () => {
    expect(resolveContract("0.24.2")).toBe("required");
  });
  it("rejects missing bundled transport and changed patch source", () => {
    expect(() => resolveContract("0.24.2", { bundled: false })).toThrow("must be bundled");
    expect(() => resolveContract("0.24.2", { patch: "changed" })).toThrow(
      "changed fs-safe publication patch source",
    );
  });
  it("explicitly omits the historical contract while current source remains strict", () => {
    expect(resolveContract("0.21.1")).toBe("not-applicable");
    expect(resolveContract("0.21.1", { current: true })).toBe("required");
    expect(resolveContract("0.24.3")).toBe("required");
  });
});
