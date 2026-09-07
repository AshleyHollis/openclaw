import path from "node:path";

// The privileged parent supplies private filesystem/network isolation and this
// clean environment before Node starts; never inherit operator credentials.
const allowedEnvironment = new Set([
  "PATH",
  "LANG",
  "HOME",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "TMPDIR",
  "XDG_CACHE_HOME",
  // Set by the repository's documented scripts/tsx.mjs preload.
  "TSX_DISABLE_CACHE",
]);
let stage = "input";
try {
  const [
    operation,
    sourcePath,
    targetPath,
    agentId,
    privateStateDir,
    publicationDir,
    approvalManifestPath,
    approvalManifestSha256,
    ...publicationDigests
  ] = process.argv.slice(2);
  if (
    (operation !== "prepare" && operation !== "publish") ||
    !sourcePath ||
    !targetPath ||
    !agentId ||
    !privateStateDir ||
    !publicationDir ||
    !approvalManifestPath ||
    !approvalManifestSha256 ||
    (operation === "prepare"
      ? publicationDigests.length !== 0
      : publicationDigests.length !== 2 ||
        publicationDigests.some((value) => !/^[a-f0-9]{64}$/.test(value))) ||
    [sourcePath, targetPath, privateStateDir, publicationDir, approvalManifestPath].some(
      (value) => !path.isAbsolute(value),
    ) ||
    !/^[a-f0-9]{64}$/.test(approvalManifestSha256) ||
    Object.keys(process.env).some((name) => !allowedEnvironment.has(name)) ||
    process.env.OPENCLAW_STATE_DIR !== privateStateDir ||
    process.env.OPENCLAW_HOME !== privateStateDir ||
    process.env.HOME !== privateStateDir ||
    process.env.OPENCLAW_CONFIG_PATH !== path.join(privateStateDir, "openclaw.json")
  ) {
    throw new Error(
      "An explicit private environment and pinned preparation approval are required.",
    );
  }
  stage = "runtime-paths";
  const { pinRuntimePaths } = await import("../src/config/paths.js");
  const pinned = pinRuntimePaths();
  if (
    pinned.stateDir !== privateStateDir ||
    pinned.configPath !== process.env.OPENCLAW_CONFIG_PATH
  ) {
    throw new Error("Runtime paths did not select the private preparation state.");
  }
  stage = "runtime-import";
  const { routeLogsToStderr } = await import("../src/logging/console.js");
  routeLogsToStderr();
  const { prepareOfflineSessionSnapshot, publishPreparedOfflineSessionSnapshot } =
    await import("./lib/offline-session-preparation.mts");
  // Only this dedicated offline process requires atomic no-replace publication.
  // Configure after runtime imports so normal app filesystem defaults stay untouched.
  const { configureFsSafeNative } = await import("../src/infra/fs-safe-defaults.js");
  configureFsSafeNative({ mode: "require" });
  stage = operation;
  const options = {
    sourcePath,
    targetPath,
    agentId,
    privateStateDir,
    publicationDir,
    approvalManifestPath,
    approvalManifestSha256,
  };
  const result =
    operation === "prepare"
      ? { status: "prepared", ...(await prepareOfflineSessionSnapshot(options)) }
      : {
          status: "verified",
          ...(await publishPreparedOfflineSessionSnapshot({
            ...options,
            preparationRecordSha256: publicationDigests[0]!,
            publicationIntentSha256: publicationDigests[1]!,
          })),
        };
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  console.error(
    `Offline Session preparation refused at ${stage}; retain private preparation for investigation.`,
  );
  process.exitCode = 1;
}
