import { readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function validateInstalledPluginRuntime(
  root,
  hostRoot = "/app/node_modules/openclaw",
) {
  const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
  const manifest = await readJson("package.json");
  const lock = await readJson("package-lock.json");
  if (
    manifest.name !== "openclaw-nas-plugin-runtime" ||
    lock.name !== manifest.name ||
    lock.lockfileVersion !== 3
  )
    throw new Error("image plugin installation identity mismatch");
  const declared = manifest.dependencies;
  const locked = lock.packages?.[""]?.dependencies;
  if (
    !declared ||
    !locked ||
    Object.keys(declared).length !== Object.keys(locked).length ||
    Object.entries(declared).some(([name, value]) => locked[name] !== value)
  )
    throw new Error("image plugin installation declarations differ from lock");
  for (const id of ["codex", "discord"]) {
    const name = `@openclaw/${id}`;
    const installed = await readJson(`node_modules/${name}/package.json`);
    const entry = lock.packages?.[`node_modules/${name}`];
    if (
      !declared[name] ||
      installed.name !== name ||
      !installed.version ||
      installed.version !== entry?.version ||
      !/^sha512-[A-Za-z0-9+/]+=*$/u.test(entry.integrity ?? "")
    )
      throw new Error("image plugin package differs from installation lock");
    if (
      (await readlink(path.join(root, `node_modules/${name}/node_modules/openclaw`))) !== hostRoot
    )
      throw new Error("image plugin host peer differs");
  }
  if ((await readlink(path.join(root, "node_modules/openclaw"))) !== hostRoot)
    throw new Error("image root host peer differs");
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await validateInstalledPluginRuntime("/opt/openclaw-plugin-runtime");
}
