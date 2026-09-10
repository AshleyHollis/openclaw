import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

// Selects exclusive authenticated plugin dispatch before configurable routes.
export const CONTROL_UI_HTTP_RELAY_HEADER = "x-openclaw-control-ui-relay";

/** Bounded JSON routes, not arbitrary URLs, headers or Session grants. */
export type ControlUiHttpRelayRoute = {
  path: string;
  method: "GET" | "POST";
  maxRequestBytes: number;
  maxResponseBytes: number;
};

export function normalizeControlUiHttpRelayRoutes(
  value: unknown,
): ControlUiHttpRelayRoute[] | null {
  if (!Array.isArray(value) || value.length > 16) {
    return null;
  }
  const routes: ControlUiHttpRelayRoute[] = [];
  for (const item of value) {
    const route = asNullableRecord(item);
    if (
      !route ||
      Object.keys(route).some(
        (key) => !["path", "method", "maxRequestBytes", "maxResponseBytes"].includes(key),
      )
    ) {
      return null;
    }
    const { path, method, maxRequestBytes, maxResponseBytes } = route;
    // Literal segments exclude queries and encoded aliases that routing layers
    // could otherwise interpret differently.
    if (
      typeof path !== "string" ||
      path.length > 1024 ||
      !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(path) ||
      (method !== "GET" && method !== "POST")
    ) {
      return null;
    }
    if (
      typeof maxRequestBytes !== "number" ||
      !Number.isInteger(maxRequestBytes) ||
      maxRequestBytes < 0 ||
      maxRequestBytes > 12 * 1024 * 1024 ||
      (method === "GET" && maxRequestBytes !== 0)
    ) {
      return null;
    }
    if (
      typeof maxResponseBytes !== "number" ||
      !Number.isInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > 1024 * 1024
    ) {
      return null;
    }
    if (routes.some((existing) => existing.path === path && existing.method === method)) {
      return null;
    }
    routes.push({ path, method, maxRequestBytes, maxResponseBytes });
  }
  return routes;
}
