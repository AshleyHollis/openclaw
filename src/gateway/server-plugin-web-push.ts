import { isWebPushQuietHours, webPushAgentAllowed } from "../infra/push-web-preferences.js";
import { prepareWebPushNotificationSender } from "../infra/push-web.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { resolveControlUiWebPushUrl } from "./control-ui-shared.js";
import { authorizeOperatorScopesForRequiredScope } from "./method-scopes.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { getInProcessGatewayRequestContext } from "./server-plugin-in-process-dispatch.js";
import { listCurrentWebPushTargets, withCurrentWebPushAuthority } from "./web-push-authority.js";

const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const record = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_TTL_SECONDS = 3600;
type Send = NonNullable<PluginRuntime["gateway"]["sendPrivateWebPush"]>;

export async function sendPrivateWebPushForRequester(
  target: Parameters<Send>[0],
  publication: Parameters<Send>[1],
  resolveGatewayContext?: GatewayContextResolver,
): ReturnType<Send> {
  const { pageId, recordId, expiresAtMs } = target;
  if (
    typeof pageId !== "string" ||
    !id.test(pageId) ||
    typeof recordId !== "string" ||
    !record.test(recordId) ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs > Date.now() + MAX_TTL_SECONDS * 1000
  ) {
    throw new Error(
      "Private Web Push requires an exact plugin page, opaque record and bounded expiry.",
    );
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  const registry = scope?.pluginRegistry;
  const plugin = registry?.plugins.find((item) => item.id === scope?.pluginId);
  const profileRef = scope?.client?.authenticatedUserProfile?.profileId;
  const context = getInProcessGatewayRequestContext(resolveGatewayContext);
  if (!scope || !registry || !plugin || !id.test(plugin.id) || !profileRef || !context) {
    throw new Error(
      "Private Web Push requires a current plugin and authenticated operator profile.",
    );
  }

  const activePlugin = capturePluginLifecycleAuthority(registry, plugin, {
    admittedRuntime: true,
  });
  const assertCurrent = () => {
    scope.signal?.throwIfAborted();
    if (
      !activePlugin?.() ||
      scope.gatewayMethodDispatchAllowed !== true ||
      scope.hasCurrentClientAuthority?.() !== true ||
      scope.client?.connect.role !== "operator" ||
      scope.client.authenticatedUserProfile?.profileId !== profileRef ||
      !authorizeOperatorScopesForRequiredScope("operator.write", scope.client.connect.scopes ?? [])
        .allowed
    ) {
      throw new Error("Private Web Push requester authority is no longer current.");
    }
  };
  assertCurrent();
  const empty = { attempted: 0, accepted: 0 };
  if (expiresAtMs <= Date.now()) {
    return empty;
  }
  const send = await prepareWebPushNotificationSender();
  const path = `plugin?${new URLSearchParams({
    plugin: plugin.id,
    id: pageId,
    "p.notificationRecord": recordId,
  })}`;
  const tag = `plugin:${plugin.id}:${recordId}`;
  const results = await withCurrentWebPushAuthority(
    {
      getRuntimeConfig: context.getRuntimeConfig,
      preparePublication: async () => {
        assertCurrent();
        await publication.prepare();
      },
    },
    (authority) => {
      const now = Date.now();
      const profileId = authority.profile?.readCurrentIdentity(profileRef)?.profileId;
      if (!profileId || expiresAtMs - now < 1000) {
        return undefined;
      }
      const subscriptions = listCurrentWebPushTargets({
        ...authority,
        requiredScopes: ["operator.read"],
      }).flatMap(({ userProfileId, preferences, subscription }) =>
        userProfileId === profileId &&
        preferences.enabled &&
        !isWebPushQuietHours(preferences, now) &&
        webPushAgentAllowed(preferences)
          ? [subscription]
          : [],
      );
      if (!subscriptions.length) {
        return undefined;
      }
      return {
        start: () => {
          assertCurrent();
          const TTL = Math.floor((expiresAtMs - Date.now()) / 1000);
          if (TTL < 1) {
            return undefined;
          }
          // JavaScript plugins must return a literal, synchronous acknowledgement.
          const claimed: unknown = publication.claim();
          if (claimed !== true) {
            return undefined;
          }
          return send({
            subscriptions,
            payload: {
              title: "OpenClaw",
              body: "An item needs your attention.",
              url: resolveControlUiWebPushUrl(authority.cfg, path),
              tag,
              renotify: false,
            },
            deliveryOptions: { TTL, urgency: "high", topic: recordId.replaceAll("-", "") },
          });
        },
      };
    },
  );
  return results
    ? { attempted: results.length, accepted: results.filter((result) => result.ok).length }
    : empty;
}
