import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const localProtocolPattern = /^(?:file|link|workspace):/u;
const dependencySections = ["dependencies", "optionalDependencies"];

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExact(value, expected, label) {
  if (value !== expected) {
    throw new Error(`${label} ${String(value ?? "<missing>")} does not match ${expected}`);
  }
}

function normalizedRecord(value, label) {
  if (value === undefined) {
    return {};
  }
  const record = requireObject(value, label);
  return Object.fromEntries(
    Object.entries(record).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function validateNoLocalProtocols(packages) {
  for (const [packagePath, metadata] of Object.entries(packages)) {
    const record = requireObject(metadata, `shrinkwrap package ${packagePath || "<root>"}`);
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, spec] of Object.entries(
        normalizedRecord(record[section], `${packagePath} ${section}`),
      )) {
        if (typeof spec !== "string" || !spec.trim()) {
          throw new Error(`${packagePath || "<root>"} ${section}.${name} must be a string`);
        }
        if (localProtocolPattern.test(spec.trim())) {
          throw new Error(`forbidden local dependency ${section}.${name}=${spec}`);
        }
      }
    }
  }
}

function validateDirectDependencyLocks(rootPackage, packages) {
  for (const section of dependencySections) {
    for (const name of Object.keys(normalizedRecord(rootPackage[section], `root ${section}`))) {
      const lockPath = `node_modules/${name}`;
      const locked = requireObject(packages[lockPath], `shrinkwrap ${lockPath}`);
      if (typeof locked.version !== "string" || !locked.version.trim()) {
        throw new Error(`shrinkwrap ${lockPath} is missing a version`);
      }
      if (
        typeof locked.resolved !== "string" ||
        !locked.resolved.startsWith("https://registry.npmjs.org/")
      ) {
        throw new Error(`shrinkwrap ${lockPath} is not pinned to the npm registry`);
      }
      if (typeof locked.integrity !== "string" || !locked.integrity.startsWith("sha512-")) {
        throw new Error(`shrinkwrap ${lockPath} is missing sha512 integrity`);
      }
    }
  }
}

export function validatePackedMetadata({ manifest, shrinkwrap, expectedName, expectedVersion }) {
  requireExact(manifest.name, expectedName, "package name");
  requireExact(manifest.version, expectedVersion, "package version");
  requireExact(shrinkwrap.name, expectedName, "shrinkwrap name");
  requireExact(shrinkwrap.version, expectedVersion, "shrinkwrap version");
  requireExact(shrinkwrap.lockfileVersion, 3, "shrinkwrap lockfileVersion");

  const packages = requireObject(shrinkwrap.packages, "shrinkwrap packages");
  const rootPackage = requireObject(packages[""], "shrinkwrap root package");
  requireExact(rootPackage.name, expectedName, "shrinkwrap root name");
  requireExact(rootPackage.version, expectedVersion, "shrinkwrap root version");
  if (rootPackage.devDependencies !== undefined) {
    throw new Error("shrinkwrap root must not lock devDependencies");
  }
  for (const section of dependencySections) {
    const manifestDependencies = normalizedRecord(manifest[section], `package ${section}`);
    const lockedDependencies = normalizedRecord(rootPackage[section], `shrinkwrap root ${section}`);
    if (JSON.stringify(manifestDependencies) !== JSON.stringify(lockedDependencies)) {
      throw new Error(`shrinkwrap root ${section} does not match package.json`);
    }
  }
  validateNoLocalProtocols(packages);
  validateDirectDependencyLocks(rootPackage, packages);
}

async function main() {
  const [packagePath, shrinkwrapPath, expectedName, expectedVersion] = process.argv.slice(2);
  if (!packagePath || !shrinkwrapPath || !expectedName || !expectedVersion) {
    throw new Error(
      "usage: validate-packed-metadata.mjs <package.json> <npm-shrinkwrap.json> <name> <version>",
    );
  }
  const [manifest, shrinkwrap] = await Promise.all(
    [packagePath, shrinkwrapPath].map(async (filePath) =>
      JSON.parse(await readFile(filePath, "utf8")),
    ),
  );
  validatePackedMetadata({ manifest, shrinkwrap, expectedName, expectedVersion });
  console.log(`packed metadata valid: ${expectedName}@${expectedVersion}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
