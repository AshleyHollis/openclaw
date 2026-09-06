import type { ServerResponse } from "node:http";
import { isUint8Array } from "node:util/types";
import { getRuntimeConfig } from "../config/io.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import type { PluginHttpRouteRegistration, PluginRegistry } from "../plugins/registry.js";
import { getActivePluginHttpRouteRegistry } from "../plugins/runtime.js";
import { parseControlUiUserAvatarPath } from "./control-ui-contract.js";
import { isControlUiPluginAllowed } from "./control-ui-plugin-policy.js";
import {
  isControlUiApprovalDocumentPath,
  isControlUiPluginManagerRequest,
} from "./control-ui-routing.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { isHooksRequestPath, normalizeHooksBasePath } from "./hooks-route-contract.js";
import { resolvePluginRoutePathContext } from "./server/plugins-http/path-context.js";
import { findMatchingPluginHttpRoutes } from "./server/plugins-http/route-match.js";

/** Capture the native plugin's exact route and activation, not a reusable bearer grant. */
export function resolveControlUiHttpRelayAuthority(
  path: string,
  method: string,
  basePath?: string,
) {
  if (method !== "GET" && method !== "POST") {
    return undefined;
  }
  const registry = getActivePluginHttpRouteRegistry();
  if (!registry) {
    return undefined;
  }
  const matches = findMatchingPluginHttpRoutes(registry, resolvePluginRoutePathContext(path));
  const route = matches[0];
  if (
    matches.length !== 1 ||
    !route ||
    route.path !== path ||
    route.match !== "exact" ||
    route.auth !== "gateway" ||
    route.gatewayRuntimeScopeSurface === "trusted-operator"
  ) {
    return undefined;
  }
  const record = registry.plugins.find((plugin) => plugin.id === route.pluginId);
  const declaredRoute = record?.controlUi?.httpRoutes?.find(
    (item) => item.path === path && item.method === method,
  );
  if (!record || !declaredRoute || !path.startsWith(`/plugins/${record.id}/`)) {
    return undefined;
  }
  const { maxRequestBytes, maxResponseBytes } = declaredRoute;
  const activationCurrent = capturePluginLifecycleAuthority(registry, record);
  const isCurrent = (
    currentRegistry: PluginRegistry = registry,
    currentRoute: PluginHttpRouteRegistration = route,
  ) => {
    if (
      !activationCurrent?.() ||
      currentRegistry !== registry ||
      currentRoute !== route ||
      getActivePluginHttpRouteRegistry() !== registry ||
      !isControlUiPluginAllowed(record)
    ) {
      return false;
    }
    if (
      !record.controlUi?.httpRoutes?.includes(declaredRoute) ||
      declaredRoute.path !== path ||
      declaredRoute.method !== method ||
      declaredRoute.maxRequestBytes !== maxRequestBytes ||
      declaredRoute.maxResponseBytes !== maxResponseBytes
    ) {
      return false;
    }
    const cfg = getRuntimeConfig();
    const uiBase = normalizeControlUiBasePath(basePath ?? cfg.gateway?.controlUi?.basePath);
    if (cfg.gateway?.controlUi?.enabled === false) {
      return false;
    }
    try {
      if (cfg.hooks?.enabled && isHooksRequestPath(path, normalizeHooksBasePath(cfg.hooks.path))) {
        return false;
      }
    } catch {
      return false;
    }
    if (
      isControlUiApprovalDocumentPath({ basePath: uiBase, pathname: path }) ||
      isControlUiPluginManagerRequest({ basePath: uiBase, pathname: path, method }) ||
      parseControlUiUserAvatarPath(path, uiBase).matched
    ) {
      return false;
    }
    const current = findMatchingPluginHttpRoutes(registry, resolvePluginRoutePathContext(path));
    return (
      current.length === 1 &&
      current[0] === route &&
      route.path === path &&
      route.auth === "gateway" &&
      route.match === "exact" &&
      route.pluginId === record.id &&
      route.gatewayRuntimeScopeSurface !== "trusted-operator"
    );
  };
  if (!isCurrent()) {
    return undefined;
  }
  return {
    scope: method === "GET" ? ("operator.read" as const) : ("operator.write" as const),
    maxRequestBytes,
    maxResponseBytes,
    isCurrent,
  };
}

/** Bound emitted bytes without buffering a second response or completing a partial success. */
export function installControlUiHttpResponseLimit(res: ServerResponse, maxBytes: number) {
  type Callback = (error?: Error | null) => void;
  // Retain exact method identities for restoration; calls below use bound versions.
  // oxlint-disable-next-line typescript/unbound-method
  const originalWrite = res.write;
  // oxlint-disable-next-line typescript/unbound-method -- captured only for binding/restoration
  const originalEnd = res.end;
  const write = originalWrite.bind(res);
  const end = originalEnd.bind(res);
  let bytes = 0;
  let tripped = false;
  const accept = (chunk: unknown, encoding: BufferEncoding | undefined, callback?: Callback) => {
    const size =
      typeof chunk === "string"
        ? Buffer.byteLength(chunk, encoding)
        : isUint8Array(chunk)
          ? chunk.byteLength
          : 0;
    if (!tripped && size <= maxBytes - bytes) {
      bytes += size;
      return true;
    }
    tripped = true;
    res.destroy();
    // A rejected write must not leave a callback-awaiting handler orphaned.
    if (callback) {
      queueMicrotask(() =>
        callback(new Error("Plugin HTTP response exceeded its declared byte limit.")),
      );
    }
    return false;
  };
  res.write = (
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | Callback,
    callback?: Callback,
  ) => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (!accept(chunk, encoding, done)) {
      return false;
    }
    return encoding === undefined ? write(chunk, done) : write(chunk, encoding, done);
  };
  res.end = (
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | Callback,
    callback?: Callback,
  ) => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const done =
      typeof chunk === "function"
        ? // SAFETY: a function in the first slot is Node's end(callback) overload, not response data.
          (chunk as Callback)
        : typeof encodingOrCallback === "function"
          ? encodingOrCallback
          : callback;
    const body = typeof chunk === "function" ? undefined : chunk;
    if (!accept(body, encoding, done)) {
      return res;
    }
    return encoding === undefined ? end(body, done) : end(body, encoding, done);
  };
  const cleanup = () => {
    res.off("finish", cleanup);
    res.off("close", cleanup);
    res.write = originalWrite;
    res.end = originalEnd;
  };
  // Handlers may finish before their response. Detached writers retain the cap
  // until the actual transport finishes or closes, not just the handler promise.
  res.once("finish", cleanup);
  res.once("close", cleanup);
  return { isTripped: () => tripped };
}
