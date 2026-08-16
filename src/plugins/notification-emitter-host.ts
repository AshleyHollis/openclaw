// Host-only notification bindings. No transport credential is represented in a plugin-facing type.
import { createHash } from "node:crypto";
import type { Insertable } from "kysely";
import type { GatewayConfig } from "../config/types.gateway.js";
import { isOperatorScope, type OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayClient } from "../gateway/server-methods/shared-types.js";
import { loadPairedDevicePairingStoreRecord } from "../infra/device-pairing-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { listWebPushSubscriptions } from "../infra/push-web-store.js";
import { sendWebPushNotification } from "../infra/push-web.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  ensurePluginNotificationLedgerSchema,
  SqlitePluginNotificationLedger,
} from "./notification-emitter-ledger.js";
import type {
  PluginNotificationPrincipal,
  PluginNotificationTarget,
  PluginNotificationTransport,
  PluginNotificationTransportPayload,
} from "./notification-emitter.js";

type AssociationDatabase = {
  plugin_notification_device_associations: {
    target_id: string;
    target_kind: string;
    operator_id: string;
    authentication_method: string;
    authentication_generation: string;
    paired_device_id: string;
    pairing_generation: string;
    issuer_generation: string | null;
    scopes_json: string;
    created_at_ms: number;
    updated_at_ms: number;
  };
};

type PluginNotificationTargetOwner = {
  operatorId: string;
  authenticationMethod: "device-token";
  authenticationGeneration: string;
  pairedDeviceId: string;
  pairingGeneration: string;
  issuerGeneration?: string;
  scopes: OperatorScope[];
  role: string;
};

type PluginNotificationDeviceBinding = Pick<
  PluginNotificationTargetOwner,
  | "authenticationMethod"
  | "authenticationGeneration"
  | "pairedDeviceId"
  | "pairingGeneration"
  | "issuerGeneration"
> & { scopes: readonly OperatorScope[] };

/** Host-only authentication facts that can be bound to one plugin at use time. */
export type PluginNotificationPrincipalBinding = Omit<PluginNotificationPrincipal, "pluginId">;

const pluginNotificationClearDeliveryWindowMs = 24 * 60 * 60 * 1000;

function stateOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {};
}

function operatorScopes(scopes: readonly string[]): OperatorScope[] {
  return scopes.filter(isOperatorScope).toSorted();
}

function parseOperatorScopes(value: string): OperatorScope[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((scope) => typeof scope === "string")) {
      return undefined;
    }
    const scopes = operatorScopes(parsed);
    return scopes.length === parsed.length ? scopes : undefined;
  } catch {
    return undefined;
  }
}

function principalGeneration(params: {
  deviceId: string;
  publicKey: string;
  role: string;
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  issuerGeneration?: string;
  scopes: readonly string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        deviceId: params.deviceId,
        publicKey: params.publicKey,
        role: params.role,
        createdAtMs: params.createdAtMs,
        rotatedAtMs: params.rotatedAtMs ?? null,
        revokedAtMs: params.revokedAtMs ?? null,
        issuerGeneration: params.issuerGeneration ?? null,
        scopes: [...params.scopes].toSorted(),
      }),
    )
    .digest("hex");
}

function pairingGeneration(params: {
  deviceId: string;
  publicKey: string;
  approvedAtMs: number;
}): string {
  return createHash("sha256")
    .update(`${params.deviceId}\0${params.publicKey}\0${params.approvedAtMs}`)
    .digest("hex");
}

/** Capture the authenticated device record that owns a host notification target. */
function capturePluginNotificationTargetOwnerFromAuthenticatedDevice(params: {
  operatorId: string;
  deviceId: string;
  role: string;
  scopes: readonly string[];
  sharedGatewaySessionGeneration?: string;
}): PluginNotificationTargetOwner | undefined {
  const { deviceId, role, operatorId } = params;
  const device = loadPairedDevicePairingStoreRecord(deviceId);
  const token = device?.tokens?.[role];
  const scopes = operatorScopes(params.scopes);
  const tokenScopes = operatorScopes(token?.scopes ?? []);
  if (
    !device ||
    !token ||
    token.revokedAtMs ||
    (role === "operator" &&
      (scopes.length === 0 || !scopes.every((scope) => tokenScopes.includes(scope))))
  ) {
    return undefined;
  }
  const issuerGeneration = token.issuer?.generation;
  // Shared gateway auth first verifies this paired device during the handshake. Its
  // durable grant must then remain bound to that exact shared-auth issuer epoch.
  if (issuerGeneration && params.sharedGatewaySessionGeneration !== issuerGeneration) {
    return undefined;
  }
  return {
    operatorId,
    authenticationMethod: "device-token",
    authenticationGeneration: principalGeneration({
      deviceId,
      publicKey: device.publicKey,
      role,
      createdAtMs: token.createdAtMs,
      rotatedAtMs: token.rotatedAtMs,
      revokedAtMs: token.revokedAtMs,
      issuerGeneration,
      scopes: token.scopes,
    }),
    pairedDeviceId: deviceId,
    pairingGeneration: pairingGeneration({
      deviceId,
      publicKey: device.publicKey,
      approvedAtMs: device.approvedAtMs,
    }),
    ...(issuerGeneration ? { issuerGeneration } : {}),
    scopes,
    role,
  };
}

function capturePluginNotificationTargetOwner(
  client: GatewayClient | null | undefined,
): PluginNotificationTargetOwner | undefined {
  const deviceId = client?.connect.device?.id?.trim();
  const role = client?.connect.role?.trim();
  const operatorId = (client?.authenticatedOperatorId ?? client?.authenticatedUserId)?.trim();
  if (
    !client ||
    client.invalidated ||
    (!client.isDeviceTokenAuth && !client.usesSharedGatewayAuth) ||
    !deviceId ||
    !role ||
    !operatorId
  ) {
    return undefined;
  }
  return capturePluginNotificationTargetOwnerFromAuthenticatedDevice({
    operatorId,
    deviceId,
    role,
    scopes: client.connect.scopes ?? [],
    ...(client.sharedGatewaySessionGeneration
      ? { sharedGatewaySessionGeneration: client.sharedGatewaySessionGeneration }
      : {}),
  });
}

function isPluginNotificationDeviceBindingCurrent(params: {
  binding: PluginNotificationDeviceBinding;
  requireOperatorScopes: boolean;
  stateDir?: string;
  getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
}): boolean {
  const { binding } = params;
  const device = loadPairedDevicePairingStoreRecord(binding.pairedDeviceId, params.stateDir);
  if (
    binding.authenticationMethod !== "device-token" ||
    !device ||
    pairingGeneration({
      deviceId: device.deviceId,
      publicKey: device.publicKey,
      approvedAtMs: device.approvedAtMs,
    }) !== binding.pairingGeneration
  ) {
    return false;
  }
  const bindingScopes = operatorScopes(binding.scopes);
  if (
    bindingScopes.length !== binding.scopes.length ||
    (params.requireOperatorScopes && bindingScopes.length === 0)
  ) {
    return false;
  }
  // A shared-auth-issued device token remains valid only for the gateway's
  // live issuer epoch. Retained notification bindings must not outlive auth rotation.
  if (
    binding.issuerGeneration !== undefined &&
    params.getRequiredSharedGatewaySessionGeneration?.() !== binding.issuerGeneration
  ) {
    return false;
  }
  return Object.entries(device.tokens ?? {}).some(([role, token]) => {
    if (!token || token.revokedAtMs) {
      return false;
    }
    const tokenScopes = operatorScopes(token.scopes);
    const issuerGeneration = token.issuer?.generation;
    return (
      binding.authenticationGeneration ===
        principalGeneration({
          deviceId: device.deviceId,
          publicKey: device.publicKey,
          role,
          createdAtMs: token.createdAtMs,
          rotatedAtMs: token.rotatedAtMs,
          revokedAtMs: token.revokedAtMs,
          issuerGeneration,
          scopes: token.scopes,
        }) &&
      binding.issuerGeneration === issuerGeneration &&
      // A binding may retain a constrained scope subset, while its generation
      // always hashes the full token scope set to detect rotation or revocation.
      bindingScopes.every((scope) => tokenScopes.includes(scope))
    );
  });
}

/** Capture the exact host-authenticated principal that is allowed to emit for one plugin. */
export function capturePluginNotificationPrincipal(params: {
  pluginId: string;
  client: GatewayClient | null | undefined;
  binding?: PluginNotificationPrincipalBinding;
}): PluginNotificationPrincipal | undefined {
  if (params.binding) {
    return {
      ...params.binding,
      pluginId: params.pluginId,
      scopes: [...params.binding.scopes],
    };
  }
  const owner = capturePluginNotificationTargetOwner(params.client);
  if (!owner || owner.role !== "operator" || owner.scopes.length === 0) {
    return undefined;
  }
  return {
    operatorId: owner.operatorId,
    pluginId: params.pluginId,
    authenticationMethod: owner.authenticationMethod,
    authenticationGeneration: owner.authenticationGeneration,
    pairedDeviceId: owner.pairedDeviceId,
    pairingGeneration: owner.pairingGeneration,
    ...(owner.issuerGeneration ? { issuerGeneration: owner.issuerGeneration } : {}),
    scopes: owner.scopes,
  };
}

/**
 * Captures a verified Control UI device-token grant without retaining its bearer token.
 * The caller has already verified that token; this re-reads the paired row to bind its
 * current generation before an opaque iframe cookie references the result.
 */
export function capturePluginNotificationPrincipalBindingFromControlUiDevice(params: {
  operatorId: string;
  deviceId: string;
  scopes: readonly string[];
  sharedGatewaySessionGeneration?: string;
}): PluginNotificationPrincipalBinding | undefined {
  const owner = capturePluginNotificationTargetOwnerFromAuthenticatedDevice({
    operatorId: params.operatorId,
    deviceId: params.deviceId,
    role: "operator",
    scopes: params.scopes,
    ...(params.sharedGatewaySessionGeneration
      ? { sharedGatewaySessionGeneration: params.sharedGatewaySessionGeneration }
      : {}),
  });
  if (!owner || owner.scopes.length === 0) {
    return undefined;
  }
  return {
    operatorId: owner.operatorId,
    authenticationMethod: owner.authenticationMethod,
    authenticationGeneration: owner.authenticationGeneration,
    pairedDeviceId: owner.pairedDeviceId,
    pairingGeneration: owner.pairingGeneration,
    ...(owner.issuerGeneration ? { issuerGeneration: owner.issuerGeneration } : {}),
    scopes: owner.scopes,
  };
}

function savePluginNotificationTargetAssociation(params: {
  targetId: string;
  targetKind: "web" | "apns";
  owner: PluginNotificationTargetOwner;
  nowMs: number;
  stateDir?: string;
}): void {
  const options = stateOptions(params.stateDir);
  const database = openOpenClawStateDatabase(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensurePluginNotificationLedgerSchema(db);
      const kysely = getNodeSqliteKysely<AssociationDatabase>(db);
      const row: Insertable<AssociationDatabase["plugin_notification_device_associations"]> = {
        target_id: params.targetId,
        target_kind: params.targetKind,
        operator_id: params.owner.operatorId,
        authentication_method: params.owner.authenticationMethod,
        authentication_generation: params.owner.authenticationGeneration,
        paired_device_id: params.owner.pairedDeviceId,
        pairing_generation: params.owner.pairingGeneration,
        issuer_generation: params.owner.issuerGeneration ?? null,
        scopes_json: JSON.stringify(params.owner.scopes),
        created_at_ms: params.nowMs,
        updated_at_ms: params.nowMs,
      };
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("plugin_notification_device_associations")
          .values(row)
          .onConflict((conflict) =>
            conflict.column("target_id").doUpdateSet({
              target_kind: row.target_kind,
              operator_id: row.operator_id,
              authentication_method: row.authentication_method,
              authentication_generation: row.authentication_generation,
              paired_device_id: row.paired_device_id,
              pairing_generation: row.pairing_generation,
              issuer_generation: row.issuer_generation,
              scopes_json: row.scopes_json,
              updated_at_ms: params.nowMs,
            }),
          ),
      );
    },
    { ...options, database },
  );
}

/** Re-resolve stored device auth on every emit/clear, including revocation and issuer rotation. */
export function isPluginNotificationPrincipalCurrent(params: {
  principal: PluginNotificationPrincipal;
  stateDir?: string;
  getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
}): boolean {
  return isPluginNotificationDeviceBindingCurrent({
    binding: params.principal,
    requireOperatorScopes: true,
    stateDir: params.stateDir,
    getRequiredSharedGatewaySessionGeneration: params.getRequiredSharedGatewaySessionGeneration,
  });
}

/** Bind a Web Push subscription to the authenticated operator device which registered it. */
export function associatePluginNotificationWebTarget(params: {
  subscriptionId: string;
  client: GatewayClient | null | undefined;
  nowMs?: number;
  stateDir?: string;
}): boolean {
  const owner = capturePluginNotificationTargetOwner(params.client);
  if (!owner || owner.role !== "operator" || owner.scopes.length === 0) {
    return false;
  }
  const nowMs = params.nowMs ?? Date.now();
  savePluginNotificationTargetAssociation({
    targetId: `web:${params.subscriptionId}`,
    targetKind: "web",
    owner,
    nowMs,
    stateDir: params.stateDir,
  });
  return true;
}

export function removePluginNotificationWebTarget(params: {
  subscriptionId: string;
  stateDir?: string;
}): void {
  const options = stateOptions(params.stateDir);
  const database = openOpenClawStateDatabase(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensurePluginNotificationLedgerSchema(db);
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<AssociationDatabase>(db)
          .deleteFrom("plugin_notification_device_associations")
          .where("target_id", "=", `web:${params.subscriptionId}`),
      );
    },
    { ...options, database },
  );
}

/** Bind an APNs node to its authenticated operator, including normal node registration. */
export function associatePluginNotificationApnsTarget(params: {
  nodeId: string;
  client: GatewayClient | null | undefined;
  nowMs?: number;
  stateDir?: string;
}): boolean {
  const owner = capturePluginNotificationTargetOwner(params.client);
  const node = loadPairedDevicePairingStoreRecord(params.nodeId, params.stateDir);
  // A node may only register itself; an operator connection may associate a paired node.
  if (
    !owner ||
    !node ||
    (owner.role !== "operator" && owner.role !== "node") ||
    (owner.role === "node" && owner.pairedDeviceId !== params.nodeId)
  ) {
    return false;
  }
  const nowMs = params.nowMs ?? Date.now();
  savePluginNotificationTargetAssociation({
    targetId: `apns:${params.nodeId}`,
    targetKind: "apns",
    owner,
    nowMs,
    stateDir: params.stateDir,
  });
  return true;
}

/** List the current operator's registered targets. No subscription secret leaves this module. */
export function listPluginNotificationTargets(
  principal: PluginNotificationPrincipal,
  stateDir?: string,
  getRequiredSharedGatewaySessionGeneration?: () => string | undefined,
): PluginNotificationTarget[] {
  const options = stateOptions(stateDir);
  const database = openOpenClawStateDatabase(options);
  // Existing state databases predate this additive table. Ensure it before the
  // read so a valid subscription never degrades to an unhandled missing-table error.
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensurePluginNotificationLedgerSchema(db);
    },
    { ...options, database },
  );
  const rows = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<AssociationDatabase>(database.db)
      .selectFrom("plugin_notification_device_associations")
      .selectAll()
      .where("operator_id", "=", principal.operatorId)
      .orderBy("target_id"),
  ).rows;
  const currentRows = rows.filter((row) => {
    const scopes = parseOperatorScopes(row.scopes_json);
    if (!scopes) {
      return false;
    }
    // Associations are per-device grants, not merely operator labels. Recheck
    // each target so revoking one browser cannot leak its preview via another.
    return isPluginNotificationDeviceBindingCurrent({
      binding: {
        authenticationMethod: row.authentication_method as "device-token",
        authenticationGeneration: row.authentication_generation,
        pairedDeviceId: row.paired_device_id,
        pairingGeneration: row.pairing_generation,
        ...(row.issuer_generation ? { issuerGeneration: row.issuer_generation } : {}),
        scopes,
      },
      requireOperatorScopes: scopes.length > 0,
      stateDir,
      getRequiredSharedGatewaySessionGeneration,
    });
  });
  const currentWebIds = new Set(
    listWebPushSubscriptions(stateDir).map((entry) => `web:${entry.subscriptionId}`),
  );
  const currentApnsIds = new Set(
    currentRows
      .filter((row) => row.target_kind === "apns" && row.target_id.startsWith("apns:"))
      .map((row) => row.target_id)
      .filter((targetId) => {
        const node = loadPairedDevicePairingStoreRecord(targetId.slice("apns:".length), stateDir);
        const token = node?.tokens?.node;
        return Boolean(token && !token.revokedAtMs);
      }),
  );
  return currentRows
    .filter(
      (row) =>
        (row.target_kind === "web" && currentWebIds.has(row.target_id)) ||
        (row.target_kind === "apns" && currentApnsIds.has(row.target_id)),
    )
    .map((row) => ({ id: row.target_id }));
}

function notificationUrl(payload: PluginNotificationTransportPayload): string {
  const target = payload.target;
  if (!target) {
    return "./";
  }
  const query = new URLSearchParams({
    plugin: target.pluginId,
    id: target.tabId,
    notification: "plugin-detail",
    destination: target.destinationId,
    record: target.recordId,
  });
  return `./plugin?${query.toString()}`;
}

/** Real host-owned Web Push transport. The subscription and VAPID key remain local to the host. */
export function createHostPluginNotificationTransport(
  params: { stateDir?: string; gatewayConfig?: GatewayConfig } = {},
): PluginNotificationTransport {
  return {
    async send(target, payload, attempt) {
      if (target.id.startsWith("apns:")) {
        const {
          loadApnsRegistration,
          resolveApnsAuthConfigFromEnv,
          resolveApnsRelayConfigFromEnv,
          sendApnsPluginNotificationAlert,
        } = await import("../infra/push-apns.js");
        const nodeId = target.id.slice("apns:".length);
        const registration = await loadApnsRegistration(nodeId, params.stateDir);
        const notificationTarget = payload.target;
        if (!registration || !notificationTarget) {
          return "failed";
        }
        const result =
          registration.transport === "direct"
            ? await (async () => {
                const auth = await resolveApnsAuthConfigFromEnv(process.env);
                if (!auth.ok) {
                  return null;
                }
                return await sendApnsPluginNotificationAlert({
                  registration,
                  nodeId,
                  title: payload.preview?.title ?? "OpenClaw",
                  body: payload.preview?.body ?? "",
                  sourceId: payload.sourceId,
                  tag: payload.tag,
                  target: notificationTarget,
                  auth: auth.value,
                  timeoutMs: attempt.timeoutMs,
                  expirationUnixSeconds: Math.floor(payload.expiresAtMs / 1000),
                  signal: attempt.signal,
                });
              })()
            : await (async () => {
                const relay = resolveApnsRelayConfigFromEnv(process.env, params.gatewayConfig, {
                  registrationRelayOrigin: registration.relayOrigin,
                });
                if (!relay.ok) {
                  return null;
                }
                return await sendApnsPluginNotificationAlert({
                  registration,
                  nodeId,
                  title: payload.preview?.title ?? "OpenClaw",
                  body: payload.preview?.body ?? "",
                  sourceId: payload.sourceId,
                  tag: payload.tag,
                  target: notificationTarget,
                  relayConfig: {
                    ...relay.value,
                    timeoutMs: Math.min(relay.value.timeoutMs, attempt.timeoutMs),
                  },
                  expirationUnixSeconds: Math.floor(payload.expiresAtMs / 1000),
                  signal: attempt.signal,
                });
              })();
        if (!result) {
          return "failed";
        }
        return result.ok
          ? "accepted"
          : result.status >= 400 && result.status < 500
            ? "failed"
            : "ambiguous";
      }
      if (!target.id.startsWith("web:")) {
        return "failed";
      }
      const subscriptionId = target.id.slice("web:".length);
      const result = await sendWebPushNotification({
        subscriptionId,
        payload: {
          title: payload.preview?.title ?? "OpenClaw",
          body: payload.preview?.body ?? "",
          tag: payload.tag,
          url: notificationUrl(payload),
          notification: {
            version: payload.version,
            kind: payload.kind,
            target: payload.target,
            expiresAtMs: payload.expiresAtMs,
          },
        },
        ttlMs: payload.ttlMs,
        timeoutMs: attempt.timeoutMs,
        signal: attempt.signal,
        baseDir: params.stateDir,
      });
      if (result.ok) {
        return "accepted";
      }
      // A terminal HTTP response proves this exact subscription did not accept the payload.
      return result.statusCode && result.statusCode >= 400 && result.statusCode < 500
        ? "failed"
        : "ambiguous";
    },
    async clear(target, payload, attempt) {
      if (target.id.startsWith("apns:")) {
        const {
          loadApnsRegistration,
          resolveApnsAuthConfigFromEnv,
          resolveApnsRelayConfigFromEnv,
          sendApnsPluginNotificationClear,
        } = await import("../infra/push-apns.js");
        const nodeId = target.id.slice("apns:".length);
        const registration = await loadApnsRegistration(nodeId, params.stateDir);
        if (!registration) {
          return "failed";
        }
        const expirationUnixSeconds = Math.floor(
          (Date.now() + pluginNotificationClearDeliveryWindowMs) / 1000,
        );
        const result =
          registration.transport === "direct"
            ? await (async () => {
                const auth = await resolveApnsAuthConfigFromEnv(process.env);
                if (!auth.ok) {
                  return null;
                }
                return await sendApnsPluginNotificationClear({
                  registration,
                  nodeId,
                  sourceId: payload.sourceId,
                  tag: payload.tag,
                  auth: auth.value,
                  timeoutMs: attempt.timeoutMs,
                  expirationUnixSeconds,
                  signal: attempt.signal,
                });
              })()
            : await (async () => {
                const relay = resolveApnsRelayConfigFromEnv(process.env, params.gatewayConfig, {
                  registrationRelayOrigin: registration.relayOrigin,
                });
                if (!relay.ok) {
                  return null;
                }
                return await sendApnsPluginNotificationClear({
                  registration,
                  nodeId,
                  sourceId: payload.sourceId,
                  tag: payload.tag,
                  relayConfig: {
                    ...relay.value,
                    timeoutMs: Math.min(relay.value.timeoutMs, attempt.timeoutMs),
                  },
                  expirationUnixSeconds,
                  signal: attempt.signal,
                });
              })();
        if (!result) {
          return "failed";
        }
        return result.ok
          ? "accepted"
          : result.status >= 400 && result.status < 500
            ? "failed"
            : "ambiguous";
      }
      if (!target.id.startsWith("web:")) {
        return "failed";
      }
      const subscriptionId = target.id.slice("web:".length);
      const result = await sendWebPushNotification({
        subscriptionId,
        payload: {
          title: "",
          tag: payload.tag,
          url: "./",
          notification: {
            version: payload.version,
            kind: "clear",
            expiresAtMs: payload.expiresAtMs,
          },
        },
        // The push service may accept while this browser is offline. Retain the
        // idempotent clear for the maximum candidate lifetime so it can close
        // an already displayed tag when the device reconnects.
        ttlMs: pluginNotificationClearDeliveryWindowMs,
        timeoutMs: attempt.timeoutMs,
        signal: attempt.signal,
        baseDir: params.stateDir,
      });
      if (result.ok) {
        return "accepted";
      }
      return result.statusCode && result.statusCode >= 400 && result.statusCode < 500
        ? "failed"
        : "ambiguous";
    },
  };
}

export function createHostPluginNotificationLedger(params: { stateDir?: string } = {}) {
  return new SqlitePluginNotificationLedger(params);
}
