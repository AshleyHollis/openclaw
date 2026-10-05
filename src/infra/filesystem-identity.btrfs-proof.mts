// Release-only proof: run in the disposable Root worker with a Btrfs fixture parent.
// node --import ./scripts/tsx.mjs src/infra/filesystem-identity.btrfs-proof.mts <parent>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readDurableFilesystemIdentity } from "../plugin-sdk/file-access-runtime.js";

const parent = process.argv[2];
if (!parent || fs.statfsSync(parent).type !== 0x9123683e) {
  throw new Error("Btrfs qualification requires an explicit disposable Btrfs fixture parent");
}
const fixture = fs.mkdtempSync(path.join(parent, "openclaw-btrfs-proof-"));
fs.chmodSync(fixture, 0o700);
const nested = path.join(fixture, "nested");
const displaced = path.join(fixture, "displaced");
const subvolumes = new Set<string>();
const descriptors = new Set<number>();
const failures: unknown[] = [];
const btrfs = (...args: string[]) => execFileSync("btrfs", args, {
  encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
}).trim();
const openDirectory = (directory: string) => {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  descriptors.add(fd);
  return fd;
};
const createSubvolume = (directory: string) => {
  btrfs("subvolume", "create", directory);
  subvolumes.add(directory);
};
try {
  const outer = await readDurableFilesystemIdentity(openDirectory(fixture));
  const filesystemId = btrfs("filesystem", "show", "--raw", fixture).match(/uuid:\s*([0-9a-f-]{36})/iu)?.[1];
  assert.ok(filesystemId, "Btrfs CLI did not return a filesystem UUID");
  assert.equal(outer.filesystemId, filesystemId.toLowerCase());
  assert.equal(outer.subvolumeId, btrfs("inspect-internal", "rootid", fixture));
  createSubvolume(nested);
  const held = openDirectory(nested);
  const original = await readDurableFilesystemIdentity(held);
  assert.equal(original.filesystemId, outer.filesystemId);
  assert.equal(original.subvolumeId, btrfs("inspect-internal", "rootid", nested));
  assert.notEqual(original.subvolumeId, outer.subvolumeId);
  fs.renameSync(nested, displaced);
  subvolumes.delete(nested);
  subvolumes.add(displaced);
  createSubvolume(nested);
  const replacement = await readDurableFilesystemIdentity(openDirectory(nested));
  assert.equal(replacement.filesystemId, original.filesystemId);
  assert.notEqual(replacement.subvolumeId, original.subvolumeId);
  assert.deepEqual(await readDurableFilesystemIdentity(held), original);
  await assert.rejects(readDurableFilesystemIdentity(openDirectory("/proc/self")), {
    code: "capability-unavailable",
  });
} catch (error) {
  failures.push(error);
} finally {
  for (const fd of descriptors) {
    try { fs.closeSync(fd); } catch (error) { failures.push(error); }
  }
  for (const directory of subvolumes) {
    try { btrfs("subvolume", "delete", directory); } catch (error) { failures.push(error); }
  }
  // Never recursively remove an unconfirmed live subvolume after cleanup refusal.
  try { fs.rmdirSync(fixture); } catch (error) { failures.push(error); }
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, "Btrfs proof and cleanup failed", { cause: failures[0] });
process.stdout.write("Btrfs public SDK nested-subvolume/held-descriptor/refusal proof passed\n");
