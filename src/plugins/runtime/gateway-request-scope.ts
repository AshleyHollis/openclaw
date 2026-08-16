// Gateway request scope tracks request-local plugin runtime context across async work.
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { PluginNotificationPrincipal } from "../notification-emitter.js";
import type { PluginOrigin } from "../plugin-origin.types.js";
import type { PluginRegistry } from "../registry-types.js";

type PluginRuntimeGatewayRequestScope = {
  context?: GatewayRequestContext;
  client?: GatewayRequestOptions["client"];
  isWebchatConnect: GatewayRequestOptions["isWebchatConnect"];
  pluginId?: string;
  pluginSource?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
  gatewayMethodDispatchAllowed?: boolean;
  pluginRegistry?: PluginRegistry;
};

type PluginRuntimePluginScope = {
  pluginId: string;
  pluginSource?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
};

/**
 * Host-only facts associated with a request scope. Keep this separate from the
 * scope object: plugins may inspect the public request scope, but must never
 * receive a durable authentication binding or its device generations.
 */
type PluginRuntimeGatewayHostScope = {
  notificationPrincipal?: PluginNotificationPrincipal;
};

const PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntimeGatewayRequestScope",
);

const pluginRuntimeGatewayRequestScope = resolveGlobalSingleton<
  AsyncLocalStorage<PluginRuntimeGatewayRequestScope>
>(
  PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY,
  () => new AsyncLocalStorage<PluginRuntimeGatewayRequestScope>(),
);

const pluginRuntimeGatewayHostScopes = resolveGlobalSingleton<
  WeakMap<PluginRuntimeGatewayRequestScope, PluginRuntimeGatewayHostScope>
>(
  Symbol.for("openclaw.pluginRuntimeGatewayHostScopes"),
  () => new WeakMap<PluginRuntimeGatewayRequestScope, PluginRuntimeGatewayHostScope>(),
);

/**
 * Runs plugin gateway handlers with request-scoped context that runtime helpers can read.
 */
export function withPluginRuntimeGatewayRequestScope<T>(
  scope: PluginRuntimeGatewayRequestScope,
  run: () => T,
  hostScope?: PluginRuntimeGatewayHostScope,
): T {
  if (hostScope) {
    pluginRuntimeGatewayHostScopes.set(scope, hostScope);
  }
  return pluginRuntimeGatewayRequestScope.run(scope, run);
}

/** Runs work against an owned registry handle while preserving any gateway request facts. */
export function withPluginRuntimeRegistryScope<T>(
  registry: PluginRegistry | undefined,
  run: () => T,
): T {
  if (!registry) {
    return run();
  }
  const current = pluginRuntimeGatewayRequestScope.getStore();
  return pluginRuntimeGatewayRequestScope.run(
    { isWebchatConnect: () => false, ...current, pluginRegistry: registry },
    run,
  );
}

/**
 * Runs work under the current gateway request scope while attaching plugin identity.
 */
export function withPluginRuntimePluginScope<T>(scope: PluginRuntimePluginScope, run: () => T): T {
  const current = pluginRuntimeGatewayRequestScope.getStore();
  const scoped: PluginRuntimeGatewayRequestScope = current
    ? { ...current, pluginId: scope.pluginId }
    : {
        pluginId: scope.pluginId,
        isWebchatConnect: () => false,
      };
  if (scope.pluginSource !== undefined) {
    scoped.pluginSource = scope.pluginSource;
  } else {
    delete scoped.pluginSource;
  }
  if (scope.pluginOrigin !== undefined) {
    scoped.pluginOrigin = scope.pluginOrigin;
  } else {
    delete scoped.pluginOrigin;
  }
  if (scope.pluginTrustedOfficialInstall !== undefined) {
    scoped.pluginTrustedOfficialInstall = scope.pluginTrustedOfficialInstall;
  } else {
    delete scoped.pluginTrustedOfficialInstall;
  }
  const hostScope = current ? pluginRuntimeGatewayHostScopes.get(current) : undefined;
  // A route's host auth facts are capabilities for that route's plugin only.
  // Nested scopes for another plugin must not inherit its operator binding.
  if (
    hostScope &&
    (!hostScope.notificationPrincipal ||
      hostScope.notificationPrincipal.pluginId === scoped.pluginId)
  ) {
    pluginRuntimeGatewayHostScopes.set(scoped, hostScope);
  }
  return pluginRuntimeGatewayRequestScope.run(scoped, run);
}

/**
 * Runs work under the current gateway request scope while attaching plugin identity.
 */
export function withPluginRuntimePluginIdScope<T>(pluginId: string, run: () => T): T {
  return withPluginRuntimePluginScope({ pluginId }, run);
}

/**
 * Returns the current plugin gateway request scope when called from a plugin request handler.
 */
export function getPluginRuntimeGatewayRequestScope():
  | PluginRuntimeGatewayRequestScope
  | undefined {
  return pluginRuntimeGatewayRequestScope.getStore();
}

/** Returns the host-captured notification principal without exposing it on the SDK scope. */
export function getPluginRuntimeGatewayNotificationPrincipal():
  | PluginNotificationPrincipal
  | undefined {
  const scope = pluginRuntimeGatewayRequestScope.getStore();
  return scope ? pluginRuntimeGatewayHostScopes.get(scope)?.notificationPrincipal : undefined;
}
