import type { IncomingMessage, ServerResponse } from "node:http";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { sendGatewayAuthFailure } from "./http-common.js";
import type { PluginGatewayDispatchContext } from "./server-http-plugin-auth.js";
import type { PluginRoutePathContext } from "./server/plugins-http/path-context.js";

export type PluginHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: PluginGatewayDispatchContext,
) => Promise<boolean>;

const getHttpAuthUtilsModule = createLazyRuntimeModule(() => import("./http-auth-utils.js"));
const getPluginRouteRuntimeScopesModule = createLazyRuntimeModule(
  () => import("./server/plugin-route-runtime-scopes.js"),
);

/** A claimed relay terminates here; it cannot fall through to ordinary routes. */
export async function dispatchControlUiHttpRelay(params: {
  req: IncomingMessage;
  res: ServerResponse;
  handlePluginRequest?: PluginHttpRequestHandler;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  requestPath: string;
  pluginPathContext: PluginRoutePathContext;
  requestClientIp?: string;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<void> {
  const { req, res, handlePluginRequest } = params;
  if (!handlePluginRequest || !params.controlUiEnabled) {
    sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
    return;
  }
  const { authorizePluginGatewayHttpRequestOrReply } = await getHttpAuthUtilsModule();
  const { resolvePluginRouteRuntimeOperatorScopes } = await getPluginRouteRuntimeScopesModule();
  const authorized = await authorizePluginGatewayHttpRequestOrReply({
    req,
    res,
    auth: params.auth,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
    rateLimiter: params.rateLimiter,
    requestPath: params.requestPath,
    controlUiBasePath: params.controlUiBasePath,
    resolveOperatorScopes: resolvePluginRouteRuntimeOperatorScopes,
  });
  if (!authorized) {
    return;
  }
  const handled = await handlePluginRequest(req, res, params.pluginPathContext, {
    gatewayAuthSatisfied: true,
    gatewayRequestAuth: authorized.requestAuth,
    gatewayRequestOperatorScopes: authorized.operatorScopes,
    gatewayRequestClientIp: params.requestClientIp,
  });
  if (!handled && !res.destroyed && !res.writableEnded) {
    respondNotFound(res);
  }
}
