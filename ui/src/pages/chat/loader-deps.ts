import type { RouteLocation } from "../../router/index.ts";

export function chatSessionLoaderDeps(location: RouteLocation): string {
  return new URLSearchParams(location.search).get("session") ?? "";
}
