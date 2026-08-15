// Host-only notification bindings. No transport credential is represented in a plugin-facing type.
import { createHash } from "node:crypto";
import type { Insertable } from "kysely";
import type { GatewayConfig } from "../config/types.gateway.js";
import { isOperatorScope, type OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayClient } from "../gateway/server-methods/shared-types.js";
import { loadPairedDevicePairingStoreRecord } from "../infra/device-pairing-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  loadApnsRegistration,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsPluginNotificationAlert,
  sendApnsPluginNotificationClear,
} from "../infra/push-apns.js";
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

function stateOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {};
}

function operatorScopes(scopes: readonly string[]): OperatorScope[] {
  return scopes.filter(isOperatorScope).toSorted();
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

/** Capture the exact host-authenticated principal that is allowed to emit for one plugin. */
export function capturePluginNotificationPrincipal(params: {
  pluginId: string;
  client: GatewayClient | null | undefined;
}): PluginNotificationPrincipal | undefined {
  const client = params.client;
  const deviceId = client?.connect.device?.id?.trim();
  const role = client?.connect.role?.trim();
  const operatorId = client?.authenticatedUserId?.trim();
  if (
    !client ||
    client.invalidated ||
    !client.isDeviceTokenAuth ||
    !deviceId ||
    !role ||
    !operatorId
  ) {
    return undefined;
  }
  const device = loadPairedDevicePairingStoreRecord(deviceId);
  const token = device?.tokens?.[role];
  const scopes = operatorScopes(client.connect.scopes);
  const tokenScopes = operatorScopes(token?.scopes ?? []);
  if (
    !device ||
    !token ||
    token.revokedAtMs ||
    scopes.length === 0 ||
    !scopes.every((scope) => tokenScopes.includes(scope))
  ) {
    return undefined;
  }
  const issuerGeneration = token.issuer?.generation;
  // A shared-auth-issued device token must stay tied to the exact authenticated issuer epoch.
  if (issuerGeneration && client.sharedGatewaySessionGeneration !== issuerGeneration) {
    return undefined;
  }
  return {
    operatorId,
    pluginId: params.pluginId,
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
  };
}

/** Re-resolve stored device auth on every emit/clear, including revocation and issuer rotation. */
export function isPluginNotificationPrincipalCurrent(params: {
  principal: PluginNotificationPrincipal;
  stateDir?: string;
}): boolean {
  const { principal } = params;
  const device = loadPairedDevicePairingStoreRecord(principal.pairedDeviceId, params.stateDir);
  if (
    principal.authenticationMethod !== "device-token" ||
    !device ||
    pairingGeneration({
      deviceId: device.deviceId,
      publicKey: device.publicKey,
      approvedAtMs: device.approvedAtMs,
    }) !== principal.pairingGeneration
  ) {
    return false;
  }
  const principalScopes = operatorScopes(principal.scopes);
  if (principalScopes.length !== principal.scopes.length || principalScopes.length === 0)
    return false;
  return Object.entries(device.tokens).some(([role, token]) => {
    if (!token || token.revokedAtMs) return false;
    const tokenScopes = operatorScopes(token.scopes);
    const issuerGeneration = token.issuer?.generation;
    return (
      principal.authenticationGeneration ===
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
      principal.issuerGeneration === issuerGeneration &&
      tokenScopes.length === principalScopes.length &&
      tokenScopes.every((scope, index) => scope === principalScopes[index])
    );
  });
}

/** Bind a Web Push subscription to the authenticated operator device which registered it. */
export function associatePluginNotificationWebTarget(params: {
  subscriptionId: string;
  client: GatewayClient | null | undefined;
  nowMs?: number;
  stateDir?: string;
}): boolean {
  const principal = capturePluginNotificationPrincipal({
    pluginId: "host-association",
    client: params.client,
  });
  if (!principal) return false;
  const nowMs = params.nowMs ?? Date.now();
  const options = stateOptions(params.stateDir);
  const database = openOpenClawStateDatabase(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensurePluginNotificationLedgerSchema(db);
      const kysely = getNodeSqliteKysely<AssociationDatabase>(db);
      const row: Insertable<AssociationDatabase["plugin_notification_device_associations"]> = {
        target_id: `web:${params.subscriptionId}`,
        target_kind: "web",
        operator_id: principal.operatorId,
        authentication_method: principal.authenticationMethod,
        authentication_generation: principal.authenticationGeneration,
        paired_device_id: principal.pairedDeviceId,
        pairing_generation: principal.pairingGeneration,
        issuer_generation: principal.issuerGeneration ?? null,
        scopes_json: JSON.stringify(principal.scopes),
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
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
              updated_at_ms: nowMs,
            }),
          ),
      );
    },
    { ...options, database },
  );
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

/** Bind a paired APNs node to the currently authenticated operator device. */
export function associatePluginNotificationApnsTarget(params: {
  nodeId: string;
  client: GatewayClient | null | undefined;
  nowMs?: number;
  stateDir?: string;
}): boolean {
  const principal = capturePluginNotificationPrincipal({
    pluginId: "host-association",
    client: params.client,
  });
  const node = loadPairedDevicePairingStoreRecord(params.nodeId, params.stateDir);
  if (!principal || !node) return false;
  const nowMs = params.nowMs ?? Date.now();
  const options = stateOptions(params.stateDir);
  const database = openOpenClawStateDatabase(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensurePluginNotificationLedgerSchema(db);
      const kysely = getNodeSqliteKysely<AssociationDatabase>(db);
      const row: Insertable<AssociationDatabase["plugin_notification_device_associations"]> = {
        target_id: `apns:${params.nodeId}`,
        target_kind: "apns",
        operator_id: principal.operatorId,
        authentication_method: principal.authenticationMethod,
        authentication_generation: principal.authenticationGeneration,
        paired_device_id: principal.pairedDeviceId,
        pairing_generation: principal.pairingGeneration,
        issuer_generation: principal.issuerGeneration ?? null,
        scopes_json: JSON.stringify(principal.scopes),
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
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
              updated_at_ms: nowMs,
            }),
          ),
      );
    },
    { ...options, database },
  );
  return true;
}

/** List only targets bound to this exact current auth generation. No subscription secret leaves this module. */
export function listPluginNotificationTargets(
  principal: PluginNotificationPrincipal,
  stateDir?: string,
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
      .select(["target_id", "target_kind"])
      .where("operator_id", "=", principal.operatorId)
      .where("authentication_method", "=", principal.authenticationMethod)
      .where("authentication_generation", "=", principal.authenticationGeneration)
      .where("paired_device_id", "=", principal.pairedDeviceId)
      .where("pairing_generation", "=", principal.pairingGeneration)
      .where("issuer_generation", "is", principal.issuerGeneration ?? null)
      .orderBy("target_id"),
  ).rows;
  const currentWebIds = new Set(
    listWebPushSubscriptions(stateDir).map((entry) => `web:${entry.subscriptionId}`),
  );
  return rows
    .filter(
      (row) =>
        (row.target_kind === "web" && currentWebIds.has(row.target_id)) ||
        (row.target_kind === "apns" && row.target_id.startsWith("apns:")),
    )
    .map((row) => ({ id: row.target_id }));
}

function notificationUrl(payload: PluginNotificationTransportPayload): string {
  const target = payload.target;
  if (!target) return "./";
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
        const nodeId = target.id.slice("apns:".length);
        const registration = await loadApnsRegistration(nodeId, params.stateDir);
        if (!registration || !payload.target) return "failed";
        const result =
          registration.transport === "direct"
            ? await (async () => {
                const auth = await resolveApnsAuthConfigFromEnv(process.env);
                if (!auth.ok) return null;
                return await sendApnsPluginNotificationAlert({
                  registration,
                  nodeId,
                  title: payload.preview?.title ?? "OpenClaw",
                  body: payload.preview?.body ?? "",
                  tag: payload.tag,
                  target: payload.target,
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
                if (!relay.ok) return null;
                return await sendApnsPluginNotificationAlert({
                  registration,
                  nodeId,
                  title: payload.preview?.title ?? "OpenClaw",
                  body: payload.preview?.body ?? "",
                  tag: payload.tag,
                  target: payload.target,
                  relayConfig: {
                    ...relay.value,
                    timeoutMs: Math.min(relay.value.timeoutMs, attempt.timeoutMs),
                  },
                  signal: attempt.signal,
                });
              })();
        if (!result) return "failed";
        return result.ok
          ? "accepted"
          : result.status >= 400 && result.status < 500
            ? "failed"
            : "ambiguous";
      }
      if (!target.id.startsWith("web:")) return "failed";
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
        signal: attempt.signal,
        baseDir: params.stateDir,
      });
      if (result.ok) return "accepted";
      // A terminal HTTP response proves this exact subscription did not accept the payload.
      return result.statusCode && result.statusCode >= 400 && result.statusCode < 500
        ? "failed"
        : "ambiguous";
    },
    async clear(target, payload, attempt) {
      if (target.id.startsWith("apns:")) {
        const nodeId = target.id.slice("apns:".length);
        const registration = await loadApnsRegistration(nodeId, params.stateDir);
        if (!registration) return "failed";
        const result =
          registration.transport === "direct"
            ? await (async () => {
                const auth = await resolveApnsAuthConfigFromEnv(process.env);
                if (!auth.ok) return null;
                return await sendApnsPluginNotificationClear({
                  registration,
                  nodeId,
                  tag: payload.tag,
                  auth: auth.value,
                  timeoutMs: attempt.timeoutMs,
                  signal: attempt.signal,
                });
              })()
            : await (async () => {
                const relay = resolveApnsRelayConfigFromEnv(process.env, params.gatewayConfig, {
                  registrationRelayOrigin: registration.relayOrigin,
                });
                if (!relay.ok) return null;
                return await sendApnsPluginNotificationClear({
                  registration,
                  nodeId,
                  tag: payload.tag,
                  relayConfig: {
                    ...relay.value,
                    timeoutMs: Math.min(relay.value.timeoutMs, attempt.timeoutMs),
                  },
                  signal: attempt.signal,
                });
              })();
        if (!result) return "failed";
        return result.ok
          ? "accepted"
          : result.status >= 400 && result.status < 500
            ? "failed"
            : "ambiguous";
      }
      if (!target.id.startsWith("web:")) return "failed";
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
        ttlMs: 0,
        signal: attempt.signal,
        baseDir: params.stateDir,
      });
      if (result.ok) return "accepted";
      return result.statusCode && result.statusCode >= 400 && result.statusCode < 500
        ? "failed"
        : "ambiguous";
    },
  };
}

export function createHostPluginNotificationLedger(params: { stateDir?: string } = {}) {
  return new SqlitePluginNotificationLedger(params);
}
