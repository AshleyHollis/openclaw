import { getCompileCacheDir } from "node:module";

/** Propagate programmatic Node compile-cache activation to child processes. */
export function resolveNodeCompileCacheEnv(): NodeJS.ProcessEnv {
  const env = process.env;
  if (env.NODE_COMPILE_CACHE !== undefined || env.NODE_DISABLE_COMPILE_CACHE !== undefined) {
    return env;
  }
  const directory = getCompileCacheDir?.();
  return directory ? { ...env, NODE_COMPILE_CACHE: directory } : env;
}
