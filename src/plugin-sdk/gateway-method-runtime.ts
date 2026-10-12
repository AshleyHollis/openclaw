import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import { dispatchGatewayMethodInProcessRaw } from "../gateway/server-plugins.js";
import {
  captureScopedSessionTranscriptGatewaySource,
  type SessionTranscriptGatewaySource,
} from "../gateway/session-transcript-source-handoff.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";

/** Error envelope returned by in-process Gateway method dispatch. */
export type GatewayMethodDispatchError = NonNullable<GatewayMethodDispatchResponse["error"]>;

/** Response envelope returned to plugins after dispatching a Gateway method. */
export type GatewayMethodDispatchResponse = SchemaContract<
  Awaited<ReturnType<typeof dispatchGatewayMethodInProcessRaw>>
>;

/** Dispatch controls for plugin-initiated Gateway method calls. */
export type GatewayMethodDispatchOptions = {
  /** Wait for the Gateway's final response instead of returning the first response frame. */
  expectFinal?: boolean;
  /** Maximum time to wait for Gateway dispatch before the runtime reports a timeout. */
  timeoutMs?: number;
  /** Host-only source custody for workboard.cards.create; never serialize into RPC params. */
  sessionTranscriptSource?: SessionTranscriptGatewaySource;
};

/**
 * Dispatch a Gateway control-plane method from an authenticated plugin request scope.
 */
export async function dispatchGatewayMethod(
  /** Gateway method name, validated by the Gateway method router. */
  method: string,
  /** Method-specific params forwarded without SDK-side normalization. */
  params?: unknown,
  /** Dispatch behavior controls for response timing and timeout handling. */
  options?: GatewayMethodDispatchOptions,
): Promise<GatewayMethodDispatchResponse> {
  const scope = getPluginRuntimeGatewayRequestScope();
  const hasCurrentClientAuthority = scope?.hasCurrentClientAuthority;
  const signal = scope?.signal;
  const assertDispatchCurrent = () => {
    if (
      scope?.gatewayMethodDispatchAllowed !== true &&
      (scope?.client == null || !scope.gatewayMethodDispatchMethods?.includes(method))
    ) {
      // Gateway methods can mutate/control local runtime state; require the
      // authenticated request scope recorded by the plugin loader contract.
      const pluginLabel = scope?.pluginId ? ` for plugin "${scope.pluginId}"` : "";
      throw new Error(
        `Gateway method dispatch is reserved for entitled plugin HTTP routes or the exact allowlist of a current plugin Gateway method with contracts.gatewayMethodDispatch: ["authenticated-request"]${pluginLabel}.`,
      );
    }
  };
  assertDispatchCurrent();
  const source = captureScopedSessionTranscriptGatewaySource(
    method,
    options,
    scope,
    assertDispatchCurrent,
  );
  return await dispatchGatewayMethodInProcessRaw(method, params, {
    ...(source === undefined ? {} : { sessionTranscriptSource: source }),
    disableSyntheticClient: true,
    requireScopedClient: true,
    ...(signal ? { signal } : {}),
    ...(hasCurrentClientAuthority
      ? { hasCurrentClientAuthority: () => hasCurrentClientAuthority.call(scope) }
      : {}),
    ...(options?.expectFinal !== undefined ? { expectFinal: options.expectFinal } : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}
