import { isRecord } from "./record-shared.mjs";

export const PATCHED_FS_SAFE_NAME = "@openclaw/fs-safe";
const PATCHED_FS_SAFE_VERSION = "0.24.2";
const HISTORICAL_PATCHED_FS_SAFE_VERSION = "0.21.1";
// Independent registry input, verified against pnpm-lock.yaml's SHA512:
// SHA256 7f5be938423b7ea92d46e72c1999dbb1768c4207a7e394dfbf5b2879bdcbcb4b.
// Apply patches/@openclaw__fs-safe@0.21.1.patch (SHA256 c399b3eeebbcb7a5a99e958ad70ac6bb25d395365d91af3519bc75cca37e1dcd).
// Never learn expectations from the candidate archive. Bind atomic publication
// and the baseline synchronous authority/refusal and stage-file owners together.
const HISTORICAL_FS_SAFE_FILE_HASHES = new Map([
  ["dist/atomic.js", "d669eee5a97723f763cec99172bd82f44d1441552fd85535f63669292c7a19c2"],
  ["dist/atomic.d.ts", "a01fbdf1d6953dc57178b95b8640d5c29dc2033c997c951bd33d465e91b9abb3"],
  ["dist/publish-directory.js", "957a30ca42813f9a8689d134e61030b066ed64c254b8ca7cf26b39ed8724810d"],
  [
    "dist/publish-directory.d.ts",
    "95d91be9255473b7f8af98699a836fee9542ccee45e8ea24f90e8a1846eee9f0",
  ],
  [
    "dist/mutation-authority.js",
    "1bc13e45fd6c27777d0043c73b7652a23a69ad3f2e284eb6cde5c5f376416463",
  ],
  [
    "dist/native-staged-file.js",
    "dcb5107b3d805c4fef6e08249dc60a2c6ace4421dd93d7f5f4817b4cca974676",
  ],
  [
    "dist/sibling-staged-file.js",
    "494aa245c6c14e7bf32af768060621ffff5176d40fbc1207ac9b78c3999bc898",
  ],
  [
    "dist/staged-file-settlement.js",
    "c6718d0867bf66c8434c0eddeb1023bd0a0be36590d7c5e7ef62d41dfdaade5f",
  ],
  [
    "dist/pinned-write-input.js",
    "eb296cf4b3b22db2d5fc0e02e2e390f7ccacd4dbed1317d960267db73d230dcd",
  ],
  ["dist/native.js", "29be2ed4afc31d22dc31d7d08aa113ef4823392d3fe144c576f9d9604b004a73"],
]);

// Independently verified registry archive SHA256
// 974d02ea9609b760300e2716916551d3373750465ef794ec2347627691db12ff,
// with patches/@openclaw__fs-safe@0.24.2.patch (same patch SHA256 above).
// Retain the frozen 0.21.1 byte contract separately from current runtime owners.
const FS_SAFE_FILE_HASHES = new Map([
  ["dist/atomic.js", "d669eee5a97723f763cec99172bd82f44d1441552fd85535f63669292c7a19c2"],
  ["dist/atomic.d.ts", "a01fbdf1d6953dc57178b95b8640d5c29dc2033c997c951bd33d465e91b9abb3"],
  ["dist/publish-directory.js", "957a30ca42813f9a8689d134e61030b066ed64c254b8ca7cf26b39ed8724810d"],
  [
    "dist/publish-directory.d.ts",
    "95d91be9255473b7f8af98699a836fee9542ccee45e8ea24f90e8a1846eee9f0",
  ],
  [
    "dist/mutation-authority.js",
    "ff1eb74ee03dacdd978f75899ae88acedaff7b30003329c59eb2cd54973654b0",
  ],
  [
    "dist/native-staged-file.js",
    "ec8b568f85364475eba1d677fc6f6145f73e99d7396d72203f198274da63c426",
  ],
  [
    "dist/sibling-staged-file.js",
    "78cf31f83e1e6c5f16c548556f400388893329cdeac3bfb65877b8eec5eaf46b",
  ],
  [
    "dist/staged-file-settlement.js",
    "aed80d6185486a360dd8a5c34427c43147bca013c95ae1c61438f6ee030ce3e0",
  ],
  [
    "dist/pinned-write-input.js",
    "5fc2caa8453e95c162e2b493d52727f725ceba93edaa2ccbe375e6b6686fcf69",
  ],
  ["dist/native.js", "11d43dc0f9e9d7decaa4b5a8d944c290c76370df53ba6d0723a7bdb1bfc4bcdf"],
]);

export function isSupportedPatchedFsSafeVersion(version: unknown): boolean {
  return version === PATCHED_FS_SAFE_VERSION || version === HISTORICAL_PATCHED_FS_SAFE_VERSION;
}

export function collectPatchedFsSafeArtifactErrors({
  declaredVersion,
  manifest,
  files,
  sha256,
}: {
  declaredVersion: unknown;
  manifest: unknown;
  files: ReadonlySet<string>;
  sha256: (file: string) => string | undefined;
}): string[] {
  const errors: string[] = [];
  const expectedVersion =
    declaredVersion === HISTORICAL_PATCHED_FS_SAFE_VERSION
      ? HISTORICAL_PATCHED_FS_SAFE_VERSION
      : PATCHED_FS_SAFE_VERSION;
  const expectedHashes =
    expectedVersion === HISTORICAL_PATCHED_FS_SAFE_VERSION
      ? HISTORICAL_FS_SAFE_FILE_HASHES
      : FS_SAFE_FILE_HASHES;
  if (!isSupportedPatchedFsSafeVersion(declaredVersion)) {
    errors.push(
      `package.json dependencies.${PATCHED_FS_SAFE_NAME} must be pinned to patched version ${PATCHED_FS_SAFE_VERSION}`,
    );
  }
  if (!isRecord(manifest) || manifest.version !== expectedVersion || manifest.type !== "module") {
    errors.push(`bundled ${PATCHED_FS_SAFE_NAME} must be ESM version ${expectedVersion}`);
  }
  const exports = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports : {};
  const atomic = exports["./atomic"];
  if (
    !isRecord(atomic) ||
    atomic.default !== "./dist/atomic.js" ||
    atomic.types !== "./dist/atomic.d.ts"
  ) {
    errors.push(`bundled ${PATCHED_FS_SAFE_NAME} must expose the patched atomic entry`);
  }
  for (const [file, hash] of expectedHashes) {
    if (!files.has(file)) {
      errors.push(`bundled ${PATCHED_FS_SAFE_NAME} is missing required runtime entry ${file}`);
    } else if (sha256(file) !== hash) {
      errors.push(`bundled ${PATCHED_FS_SAFE_NAME} has unpatched or changed runtime entry ${file}`);
    }
  }
  // Keep the native platform selection/repair contract; bundling JS does not
  // make a build-host native binary acceptable on every consumer platform.
  const optional =
    isRecord(manifest) && isRecord(manifest.optionalDependencies)
      ? manifest.optionalDependencies
      : {};
  for (const platform of [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64-gnu",
    "linux-arm64-musl",
    "linux-x64-gnu",
    "linux-x64-musl",
    "win32-x64-msvc",
  ]) {
    if (optional[`${PATCHED_FS_SAFE_NAME}-${platform}`] !== expectedVersion) {
      errors.push(
        `bundled ${PATCHED_FS_SAFE_NAME} must retain exact native dependency ${platform}`,
      );
    }
  }
  return errors;
}
