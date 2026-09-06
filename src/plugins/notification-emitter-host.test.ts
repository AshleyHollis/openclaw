import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import webPush from "web-push";
import type { GatewayClient } from "../gateway/server-methods/types.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { persistDevicePairingStoreState } from "../infra/device-pairing-store.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import { WEB_PUSH_USER_PREFERENCES_KEY } from "../infra/push-web-preferences.js";
import { registerWebPushSubscription } from "../infra/push-web.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { setUserPreferences } from "../state/user-preferences.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createUnavailableRuntime } from "./api-builder.js";
import { createPluginRecord } from "./loader-records.js";
import { createHostPluginNotificationEmitter } from "./notification-emitter-host.js";
import { createPluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";

vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: vi.fn(() => ({
      publicKey: "example-public",
      privateKey: "example-private",
    })),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async () => ({ statusCode: 201 })),
  },
}));
const dirs: string[] = [];
const env = captureEnv(["OPENCLAW_STATE_DIR"]);
afterEach(async () => {
  resetPluginRuntimeStateForTest();
  closeOpenClawStateDatabaseForTest();
  env.restore();
  vi.clearAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "notification-host-")));
  dirs.push(dir);
  setTestEnvValue("OPENCLAW_STATE_DIR", dir);
  const profile = ensureProfileForEmail("operator@example.test");
  const other = ensureProfileForEmail("other@example.test");
  const device: PairedDevice = {
    deviceId: "browser-example",
    publicKey: "public-example",
    role: "operator",
    roles: ["operator"],
    approvedScopes: ["operator.read"],
    createdAtMs: 1,
    approvedAtMs: 1,
    tokens: {
      operator: {
        token: "example-token",
        role: "operator",
        scopes: ["operator.read"],
        createdAtMs: 1,
      },
    },
  };
  const persist = () =>
    persistDevicePairingStoreState(
      { pendingById: {}, pairedByDeviceId: { [device.deviceId]: device } },
      dir,
      "paired",
    );
  persist();
  for (const owner of [profile, other])
    await registerWebPushSubscription({
      endpoint: `https://push.example.test/${owner.id}`,
      keys: { p256dh: "example-key", auth: "example-auth" },
      binding: { deviceId: device.deviceId, userProfileId: owner.id },
      baseDir: dir,
    });
  const client: GatewayClient = {
    connId: "connection-example",
    isDeviceTokenAuth: true,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read"],
      device: {
        id: device.deviceId,
        publicKey: device.publicKey,
        signature: "verified-by-host",
        signedAt: 1,
        nonce: "example-nonce",
      },
    },
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
  let active = true;
  const emitter = createHostPluginNotificationEmitter({
    pluginId: "example",
    declaration: {
      version: 1,
      id: "attention",
      requiredScopes: ["operator.read"],
      destinations: [{ id: "item", pageId: "attention" }],
    },
    stateDir: dir,
    sourceId: () => "gateway-example",
    captureAuthority: () => ({
      client,
      isCurrent: () => active,
      getRuntimeConfig: () => ({}),
      getRequiredSharedGatewaySessionGeneration: () => undefined,
    }),
  });
  const candidate = {
    version: 1 as const,
    emissionId: "event-1",
    logicalOperationId: "operation-1",
    attentionClass: "active" as const,
    preview: { title: "Example", body: "Review an item." },
    deepLink: { kind: "plugin-detail" as const, destinationId: "item", recordId: "record-1" },
    expiresAtMs: Date.now() + 60_000,
  };
  return {
    emitter,
    client,
    candidate,
    device,
    persist,
    profile,
    retire: () => {
      active = false;
    },
  };
}
describe("native host plugin notifications", () => {
  it.each(["current", "request-finished", "host-retired", "host-replaced", "unbound"] as const)(
    "retains only the actual Gateway owner for a %s registered binding",
    async (change) => {
      const f = await fixture();
      // This fixture exposes only the runtime's host-owner binding; no subagent runs.
      const context = { getRuntimeConfig: () => ({}) } as GatewayRequestContext;
      let current: GatewayRequestContext | undefined = context;
      const subagent = {};
      if (change !== "unbound") bindGatewayContextResolver(subagent, () => current);
      const unavailable = createUnavailableRuntime("setup-only");
      const runtime = new Proxy(unavailable, {
        get(target, key) {
          return key === "subagent" ? subagent : Reflect.get(target, key);
        },
      });
      const registry = createPluginRegistry({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        runtime,
        activateGlobalSideEffects: false,
      });
      const record = createPluginRecord({
        id: "example",
        source: "/plugins/example/index.ts",
        origin: "global",
        enabled: true,
        configSchema: false,
        controlUi: { entry: "dist/control-ui/index.js" },
      });
      const emitter = registry.createApi(record, { config: {} }).notifications.registerEmitter({
        version: 1,
        id: "attention",
        requiredScopes: ["operator.read"],
        destinations: [{ id: "item", pageId: "attention" }],
      });
      registry.registry.plugins.push(record);
      setActivePluginRegistry(registry.registry);
      let requestActive = true;
      const scope = {
        client: f.client,
        context,
        resolveGatewayContext: () => (requestActive ? context : undefined),
        pluginId: "example",
        pluginRegistry: registry.registry,
        isWebchatConnect: () => true,
      };
      const binding = withPluginRuntimeGatewayRequestScope(scope, () =>
        emitter?.bindCurrentOperator(),
      );
      if (change === "unbound") {
        expect(binding).toBeUndefined();
        return;
      }
      expect(binding).toBeDefined();
      expect(
        withPluginRuntimeGatewayRequestScope(
          { ...scope, resolveGatewayContext: () => undefined },
          () => emitter?.bindCurrentOperator(),
        ),
      ).toBeUndefined();
      if (change === "request-finished") requestActive = false;
      vi.mocked(webPush.setVapidDetails).mockImplementationOnce(() => {
        if (change === "host-retired") current = undefined;
        if (change === "host-replaced")
          current = { getRuntimeConfig: () => ({}) } as GatewayRequestContext;
      });
      const result = await binding!.emit(f.candidate);
      if (change === "host-retired" || change === "host-replaced") {
        expect(webPush.sendNotification).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: "failed", delivered: 0 });
      } else {
        expect(result).toMatchObject({ status: "sent", delivered: 1 });
      }
    },
  );
  it("honors native private previews and reads preference changes after preparation", async () => {
    const f = await fixture();
    const binding = f.emitter.bindCurrentOperator();
    await binding?.emit(f.candidate);
    expect(
      JSON.parse(String(vi.mocked(webPush.sendNotification).mock.calls[0]?.[1])),
    ).toMatchObject({ title: "OpenClaw", body: "An item needs your attention." });
    vi.mocked(webPush.sendNotification).mockClear();
    vi.mocked(webPush.setVapidDetails).mockImplementationOnce(() => {
      setUserPreferences(f.profile.id, {
        [WEB_PUSH_USER_PREFERENCES_KEY]: { agentIds: ["another-agent"] },
      });
    });
    expect(await binding?.emit({ ...f.candidate, emissionId: "event-2" })).toMatchObject({
      status: "suppressed",
    });
    expect(webPush.sendNotification).not.toHaveBeenCalled();
  });
  it.each(["retire", "revoke", "rotate", "profile"] as const)(
    "rechecks %s after asynchronous sender preparation",
    async (change) => {
      const f = await fixture();
      const binding = f.emitter.bindCurrentOperator();
      expect(binding).toBeDefined();
      vi.mocked(webPush.setVapidDetails).mockImplementationOnce(() => {
        if (change === "retire") f.retire();
        if (change === "profile") f.client.authenticatedUserProfile = undefined;
        const token = f.device.tokens?.operator;
        if (token && change === "revoke") {
          token.revokedAtMs = Date.now();
          f.persist();
        }
        if (token && change === "rotate") {
          token.rotatedAtMs = Date.now();
          f.persist();
        }
      });
      expect(await binding?.emit(f.candidate)).toMatchObject({ status: "failed", delivered: 0 });
      expect(webPush.sendNotification).not.toHaveBeenCalled();
    },
  );
  it("binds only the authenticated canonical profile and sends an owned native page URL", async () => {
    const f = await fixture();
    const binding = f.emitter.bindCurrentOperator();
    expect(binding).toBeDefined();
    expect(await binding?.emit(f.candidate)).toMatchObject({ status: "sent", delivered: 1 });
    const calls = vi.mocked(webPush.sendNotification).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0].endpoint).toBe(`https://push.example.test/${f.profile.id}`);
    expect(JSON.parse(String(calls[0]?.[1]))).toMatchObject({
      url: "./plugin?plugin=example&id=attention&p.notificationRecord=record-1",
      notification: { kind: "notify" },
    });
    f.retire();
    expect(await binding?.emit({ ...f.candidate, emissionId: "event-2" })).toMatchObject({
      status: "failed",
    });
    expect(calls).toHaveLength(1);
  });
});
