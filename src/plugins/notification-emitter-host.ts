import { createHash } from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOperatorRolePolicyForProfile } from "../gateway/operator-role-policy.js";
import { isOperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayClient } from "../gateway/server-methods/types.js";
import { listCurrentWebPushTargets } from "../gateway/web-push-authority.js";
import { listPairedDevicesReadOnly } from "../infra/device-pairing-store-readonly.js";
import { hasEffectivePairedDeviceRole } from "../infra/device-pairing.js";
import {
  isWebPushQuietHours,
  resolveEffectiveWebPushPreferences,
  webPushAgentAllowed,
  WEB_PUSH_USER_PREFERENCES_KEY,
} from "../infra/push-web-preferences.js";
import {
  prepareWebPushNotificationSender,
  type BoundWebPushSubscription,
} from "../infra/push-web.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { getUserPreferences } from "../state/user-preferences.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import { SqlitePluginNotificationLedger } from "./notification-emitter-ledger.js";
import { failure } from "./notification-emitter-validation.js";
import {
  PluginNotificationCoordinator,
  type PluginNotificationDeclarationV1,
  type PluginNotificationEmitter,
  type PluginNotificationPrincipal,
  type PluginNotificationTransportPayload,
} from "./notification-emitter.js";

export type PluginNotificationAuthority = {
  client: GatewayClient;
  isCurrent(): boolean;
  getRuntimeConfig(): OpenClawConfig;
  getRequiredSharedGatewaySessionGeneration(): string | undefined;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Binding identity includes endpoint keys and owner: old clears cannot cross reassociation. */
function targetId(subscription: BoundWebPushSubscription): string {
  return digest([
    subscription.subscriptionId,
    subscription.deviceId,
    subscription.userProfileId,
    subscription.keys.p256dh,
    subscription.keys.auth,
  ]);
}

export function createHostPluginNotificationEmitter(params: {
  pluginId: string;
  declaration: PluginNotificationDeclarationV1;
  stateDir?: string;
  sourceId(): string;
  captureAuthority(): PluginNotificationAuthority | undefined;
}): PluginNotificationEmitter {
  const declaration = structuredClone(params.declaration);
  const ledger = new SqlitePluginNotificationLedger({ stateDir: params.stateDir });
  function principal(
    authority: PluginNotificationAuthority,
  ): PluginNotificationPrincipal | undefined {
    const { client } = authority;
    if (
      !authority.isCurrent() ||
      client.invalidated ||
      client.internal?.syntheticClient ||
      client.connect.role !== "operator"
    ) {
      return undefined;
    }
    const profileId = client.authenticatedUserProfile?.profileId;
    const proof = client.connect.device;
    const stateOptions = params.stateDir
      ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
      : {};
    if (!profileId || !proof || resolveUserProfileId(profileId, stateOptions) !== profileId) {
      return undefined;
    }
    const shared = "usesSharedGatewayAuth" in client && client.usesSharedGatewayAuth === true;
    const sharedGeneration =
      "sharedGatewaySessionGeneration" in client &&
      typeof client.sharedGatewaySessionGeneration === "string"
        ? client.sharedGatewaySessionGeneration
        : undefined;
    if (
      !client.isDeviceTokenAuth &&
      !(
        shared &&
        sharedGeneration &&
        sharedGeneration === authority.getRequiredSharedGatewaySessionGeneration()
      )
    ) {
      return undefined;
    }
    const device = listPairedDevicesReadOnly(params.stateDir).find(
      (row) => row.deviceId === proof.id,
    );
    const token = device?.tokens?.operator;
    const approvedScopes = device?.approvedScopes ?? device?.scopes;
    if (
      !device ||
      device.publicKey !== proof.publicKey ||
      !hasEffectivePairedDeviceRole(device, "operator") ||
      !token ||
      token.revokedAtMs ||
      !approvedScopes
    ) {
      return undefined;
    }
    const issuerGeneration = token.issuer?.generation;
    if (
      issuerGeneration &&
      issuerGeneration !== authority.getRequiredSharedGatewaySessionGeneration()
    ) {
      return undefined;
    }
    const cfg = authority.getRuntimeConfig();
    const policy = resolveOperatorRolePolicyForProfile(profileId, cfg);
    if (cfg.gateway?.roles && !policy) {
      return undefined;
    }
    const allow = (requestedScopes: readonly string[], allowedScopes: readonly string[]) =>
      roleScopesAllow({ role: "operator", requestedScopes, allowedScopes });
    if (
      !allow(token.scopes, approvedScopes) ||
      !allow(declaration.requiredScopes, token.scopes) ||
      !allow(declaration.requiredScopes, client.connect.scopes ?? []) ||
      (policy && !allow(declaration.requiredScopes, policy.scopes))
    ) {
      return undefined;
    }
    return {
      operatorId: profileId,
      pluginId: params.pluginId,
      authenticationMethod: "device-token",
      authenticationGeneration: digest([
        token.createdAtMs,
        token.rotatedAtMs,
        token.scopes,
        sharedGeneration,
      ]),
      pairedDeviceId: device.deviceId,
      pairingGeneration: digest([device.publicKey, device.approvedAtMs, approvedScopes]),
      issuerGeneration,
      scopes: (client.connect.scopes ?? []).filter(isOperatorScope),
    };
  }
  return {
    bindCurrentOperator() {
      const authority = params.captureAuthority();
      if (!authority) {
        return undefined;
      }
      const captured = principal(authority);
      if (!captured) {
        return undefined;
      }
      const fingerprint = digest(captured);
      const current = () => {
        const value = principal(authority);
        return value && digest(value) === fingerprint;
      };
      const targets = () => {
        if (!current()) {
          return [];
        }
        return listCurrentWebPushTargets({
          cfg: authority.getRuntimeConfig(),
          requiredScopes: declaration.requiredScopes,
          stateDir: params.stateDir,
        }).filter(
          (target) =>
            target.userProfileId === captured.operatorId &&
            target.subscription.userProfileId === captured.operatorId,
        );
      };
      const deliver = async (
        id: string,
        payload: PluginNotificationTransportPayload,
        options: { signal: AbortSignal; timeoutMs: number },
      ) => {
        const send = await prepareWebPushNotificationSender(params.stateDir);
        // No async gap between these final mutable-authority reads and native network I/O.
        if (options.signal.aborted || !current()) {
          return "failed" as const;
        }
        const target = targets().find((value) => targetId(value.subscription) === id);
        if (!target) {
          return "failed" as const;
        }
        const user = getUserPreferences(
          captured.operatorId,
          [WEB_PUSH_USER_PREFERENCES_KEY],
          params.stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } } : {},
        )[WEB_PUSH_USER_PREFERENCES_KEY];
        const preferences = resolveEffectiveWebPushPreferences({
          user,
          device: target.subscription.devicePreferences,
        });
        if (
          payload.kind === "notify" &&
          (!preferences.enabled ||
            isWebPushQuietHours(preferences) ||
            !webPushAgentAllowed(preferences))
        ) {
          return "suppressed" as const;
        }
        if (payload.kind === "notify" && payload.expiresAtMs <= Date.now()) {
          return "failed" as const;
        }
        const url = payload.target
          ? `./plugin?${new URLSearchParams({ plugin: payload.target.pluginId, id: payload.target.pageId, "p.notificationRecord": payload.target.recordId })}`
          : undefined;
        const results = await send({
          subscriptions: [target.subscription],
          payload: {
            title:
              preferences.detailLevel === "detailed"
                ? (payload.preview?.title ?? "OpenClaw")
                : "OpenClaw",
            body:
              preferences.detailLevel === "detailed"
                ? payload.preview?.body
                : "An item needs your attention.",
            tag: payload.tag,
            url,
            renotify: false,
            notification: { version: 1, kind: payload.kind, expiresAtMs: payload.expiresAtMs },
          },
          deliveryOptions: {
            TTL:
              payload.kind === "clear"
                ? 86_400
                : Math.max(0, Math.ceil((payload.expiresAtMs - Date.now()) / 1000)),
            timeout: options.timeoutMs,
            topic: payload.tag.slice(0, 32),
          },
        });
        return results[0]?.ok
          ? ("accepted" as const)
          : results[0]?.statusCode
            ? ("failed" as const)
            : ("ambiguous" as const);
      };
      const coordinator = new PluginNotificationCoordinator({
        pluginId: params.pluginId,
        declaration,
        ledger,
        transportSourceId: () => params.sourceId(),
        targets: () => targets().map((value) => ({ id: targetId(value.subscription) })),
        transport: {
          send: (target, payload, options) => deliver(target.id, payload, options),
          clear: async (target, payload, options) => {
            const result = await deliver(target.id, payload, options);
            return result === "suppressed" ? "ambiguous" : result;
          },
        },
      });
      return {
        emit: (candidate) =>
          current() ? coordinator.emit(captured, candidate) : Promise.resolve(failure()),
        clear: (request) =>
          current()
            ? coordinator.clear(captured, request)
            : Promise.resolve({
                status: "partial" as const,
                attempted: 0,
                cleared: 0,
                failed: 1,
                ambiguous: 0,
              }),
      };
    },
  };
}
