import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  let packageRoot;
  let mode;
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--package-root") {
      packageRoot = value;
    } else if (key === "--mode") {
      mode = value;
    } else {
      throw new Error(`unknown argument: ${key ?? ""}`);
    }
  }
  if (!packageRoot || (mode !== "require" && mode !== "fallback")) {
    throw new Error(
      "usage: verify-fs-safe-native.mjs --package-root <path> --mode <require|fallback>",
    );
  }
  // createRequire keeps symlinked bases; pnpm dependencies belong to the physical package.
  return { mode, packageRoot: fs.realpathSync(packageRoot) };
}

const publicationContract = process.env.OPENCLAW_FS_SAFE_PUBLICATION_CONTRACT ?? "not-applicable";
assert.ok(
  ["required", "not-applicable"].includes(publicationContract),
  `unknown fs-safe publication contract: ${publicationContract}`,
);
const fsSafeNativeContract = process.env.OPENCLAW_FS_SAFE_NATIVE_CONTRACT ?? "required";
assert.ok(
  ["required", "bundled", "not-applicable"].includes(fsSafeNativeContract),
  `unknown fs-safe native contract: ${fsSafeNativeContract}`,
);
if (fsSafeNativeContract === "not-applicable") {
  assert.equal(
    publicationContract,
    "not-applicable",
    "publication proof cannot use a pre-native contract",
  );
  console.log(
    "Skipping fs-safe native proof: selected source has the published pre-native contract.",
  );
  process.exit(0);
}

const { mode, packageRoot } = parseArgs(process.argv.slice(2));
const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
// Resolve the manifest beside the public root entry so the native proof stays
// bound to the same installed fs-safe package that supplies its runtime.
const fsSafeEntryPath = requireFromPackage.resolve("@openclaw/fs-safe");
const fsSafeManifestPath = path.resolve(fsSafeEntryPath, "..", "..", "package.json");
const fsSafeManifest = JSON.parse(await fsPromises.readFile(fsSafeManifestPath, "utf8"));
const requireFromFsSafe = createRequire(fsSafeManifestPath);
const platformPackageNames = Object.keys(fsSafeManifest.optionalDependencies ?? {}).filter((name) =>
  name.startsWith("@openclaw/fs-safe-"),
);
const installedPlatformPackages = platformPackageNames.flatMap((name) => {
  try {
    const manifest = requireFromFsSafe.resolve(`${name}/package.json`);
    return [{ name, root: fs.realpathSync(path.dirname(manifest)) }];
  } catch {
    return [];
  }
});

const configPath = requireFromPackage.resolve("@openclaw/fs-safe/config");
const durabilityPath = requireFromPackage.resolve("@openclaw/fs-safe/durability");
const { configureFsSafeNative } = await import(pathToFileURL(configPath).href);
const { sha256File } = await import(pathToFileURL(durabilityPath).href);
configureFsSafeNative({ mode: mode === "require" ? "require" : "off" });

const temporaryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-fs-safe-proof-"));
try {
  const fixture = path.join(temporaryRoot, "fixture.txt");
  await fsPromises.writeFile(fixture, "fs-safe native package proof");
  const result = await sha256File(fixture);
  assert.match(result.digest, /^[a-f0-9]{64}$/u);

  if (publicationContract === "required") {
    assert.equal(mode, "require", "durable publication proof requires native mode");
    // Resolve from the installed consumer, never the source checkout or host aliases.
    const sdkPath = requireFromPackage.resolve("openclaw/plugin-sdk/file-access-runtime");
    assert.ok(
      fs.realpathSync(sdkPath).startsWith(`${packageRoot}${path.sep}`),
      "SDK escaped installed package",
    );
    const { stageDurableFileInDirectory, publishDurableDirectoryNoReplace } = await import(
      pathToFileURL(sdkPath).href
    );
    assert.equal(typeof stageDurableFileInDirectory, "function");
    assert.equal(typeof publishDurableDirectoryNoReplace, "function");
    const stagedDir = path.join(temporaryRoot, "staged");
    const targetDir = path.join(temporaryRoot, "published");
    await fsPromises.mkdir(stagedDir);
    const staged = await stageDurableFileInDirectory({
      directory: stagedDir,
      content: "installed SDK publication",
      mode: 0o600,
    });
    try {
      assert.equal((await staged.publish("payload.txt", { overwrite: false })).status, "published");
    } finally {
      await staged.cleanup();
    }
    const identity = fs.statSync(stagedDir, { bigint: true });
    // Promise-returning authority cannot authorize the native mutation.
    assert.throws(
      () =>
        publishDurableDirectoryNoReplace({
          stagedDir,
          targetDir,
          expectedIdentity: identity,
          assertBeforeMutation: () => Promise.resolve(),
        }),
      /must be synchronous/u,
    );
    assert.equal(fs.existsSync(targetDir), false);
    assert.equal(
      publishDurableDirectoryNoReplace({ stagedDir, targetDir, expectedIdentity: identity }).status,
      "published",
    );
    assert.equal(
      await fsPromises.readFile(path.join(targetDir, "payload.txt"), "utf8"),
      "installed SDK publication",
    );
    const collisionStage = path.join(temporaryRoot, "collision-stage");
    await fsPromises.mkdir(collisionStage);
    const collisionIdentity = fs.statSync(collisionStage, { bigint: true });
    assert.throws(() =>
      publishDurableDirectoryNoReplace({
        stagedDir: collisionStage,
        targetDir,
        expectedIdentity: collisionIdentity,
      }),
    );
    assert.equal(
      await fsPromises.readFile(path.join(targetDir, "payload.txt"), "utf8"),
      "installed SDK publication",
    );
    assert.equal(fs.existsSync(collisionStage), true);
    console.log(
      "Installed SDK durable staging/publication, asynchronous authority refusal, and collision preservation passed.",
    );
  }

  const loadedNativeModules = Object.keys(requireFromPackage.cache).filter((file) =>
    file.endsWith("fs-safe-native.node"),
  );
  if (mode === "require") {
    assert.equal(
      loadedNativeModules.length,
      1,
      "expected exactly one loaded fs-safe native binding",
    );
    const loadedNativeRoot = fs.realpathSync(path.dirname(loadedNativeModules[0]));
    if (fsSafeNativeContract === "bundled") {
      assert.equal(
        installedPlatformPackages.length,
        0,
        "bundled-native install unexpectedly contains a platform package",
      );
      const bundledNativeRoot = fs.realpathSync(
        path.join(path.dirname(fsSafeManifestPath), "dist", "native"),
      );
      assert.ok(
        loadedNativeRoot === bundledNativeRoot ||
          loadedNativeRoot.startsWith(`${bundledNativeRoot}${path.sep}`),
        "loaded fs-safe native binding did not come from the package's bundled native tree",
      );
    } else {
      assert.ok(
        installedPlatformPackages.length > 0,
        "expected at least one fs-safe platform package",
      );
      assert.ok(
        installedPlatformPackages.some(({ root }) => root === loadedNativeRoot),
        "loaded fs-safe native binding did not come from an installed platform package",
      );
    }
  } else {
    assert.equal(
      installedPlatformPackages.length,
      0,
      "fallback install contains a platform package",
    );
    assert.equal(loadedNativeModules.length, 0, "fallback loaded an fs-safe native binding");
  }
} finally {
  await fsPromises.rm(temporaryRoot, { recursive: true, force: true });
}
