import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

const mocks = vi.hoisted(() => ({
  loadPairing: vi.fn(),
  listSubscriptions: vi.fn<() => Array<{ subscriptionId: string }>>(() => []),
  sendWebPush: vi.fn(),
  loadApns: vi.fn(),
  resolveApnsAuth: vi.fn(),
  resolveApnsRelay: vi.fn(),
  sendApns: vi.fn(),
  clearApns: vi.fn(),
}));

vi.mock("../infra/device-pairing-store.js", () => ({
  loadPairedDevicePairingStoreRecord: mocks.loadPairing,
}));
vi.mock("../infra/push-web-store.js", () => ({
  listWebPushSubscriptions: mocks.listSubscriptions,
}));
vi.mock("../infra/push-web.js", () => ({
  sendWebPushNotification: mocks.sendWebPush,
}));
vi.mock("../infra/push-apns.js", () => ({
  loadApnsRegistration: mocks.loadApns,
  resolveApnsAuthConfigFromEnv: mocks.resolveApnsAuth,
  resolveApnsRelayConfigFromEnv: mocks.resolveApnsRelay,
  sendApnsPluginNotificationAlert: mocks.sendApns,
  sendApnsPluginNotificationClear: mocks.clearApns,
}));

import {
  associatePluginNotificationApnsTarget,
  associatePluginNotificationWebTarget,
  capturePluginNotificationPrincipal,
  createHostPluginNotificationTransport,
  isPluginNotificationPrincipalCurrent,
  listPluginNotificationTargets,
} from "./notification-emitter-host.js";
import {
  createPluginNotificationEmitter,
  PluginNotificationCoordinator,
} from "./notification-emitter.js";
import { withPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

function pairedDevice(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: "browser-1",
    publicKey: "public-key-1",
    approvedAtMs: 10,
    tokens: {
      operator: {
        token: "device-token-secret",
        role: "operator",
        scopes: ["operator.read"],
        createdAtMs: 10,
        issuer: { kind: "shared-gateway-auth", generation: "issuer-1" },
      },
    },
    ...overrides,
  };
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    authenticatedOperatorId: "operator@example.test",
    authenticatedUserId: "operator@example.test",
    isDeviceTokenAuth: true,
    sharedGatewaySessionGeneration: "issuer-1",
    connect: {
      device: { id: "browser-1" },
      role: "operator",
      scopes: ["operator.read"],
    },
    ...overrides,
  } as never;
}

describe("host plugin notification principal", () => {
  it("binds a paired browser under shared gateway auth without a profile or device-token auth", async () => {
    mocks.loadPairing.mockReturnValue(pairedDevice());
    const sharedGatewayClient = client({
      authenticatedOperatorId: "gateway:default-operator",
      authenticatedUserId: undefined,
      isDeviceTokenAuth: false,
      usesSharedGatewayAuth: true,
    });

    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-notification-shared-auth-"));
    try {
      const principal = capturePluginNotificationPrincipal({
        pluginId: "board",
        client: sharedGatewayClient,
      });

      expect(principal).toMatchObject({
        operatorId: "gateway:default-operator",
        pairedDeviceId: "browser-1",
        scopes: ["operator.read"],
      });
      expect(
        associatePluginNotificationWebTarget({
          subscriptionId: "shared-auth-browser",
          client: sharedGatewayClient,
          stateDir: dir,
        }),
      ).toBe(true);
    } finally {
      closeOpenClawStateDatabaseForTest();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("binds paired auth, issuer generation, revocation, and current scopes without serializing a token", () => {
    const device = pairedDevice();
    mocks.loadPairing.mockReturnValue(device);
    const currentClient = client();
    const principal = capturePluginNotificationPrincipal({
      pluginId: "board",
      client: currentClient,
    });

    expect(principal).toMatchObject({
      pluginId: "board",
      operatorId: "operator@example.test",
      authenticationMethod: "device-token",
      pairedDeviceId: "browser-1",
      issuerGeneration: "issuer-1",
      scopes: ["operator.read"],
    });
    expect(JSON.stringify(principal)).not.toContain("device-token-secret");
    expect(
      isPluginNotificationPrincipalCurrent({
        principal: principal!,
        getRequiredSharedGatewaySessionGeneration: () => "issuer-1",
      }),
    ).toBe(true);

    (device.tokens.operator as { revokedAtMs?: number }).revokedAtMs = 11;
    expect(
      isPluginNotificationPrincipalCurrent({
        principal: principal!,
        getRequiredSharedGatewaySessionGeneration: () => "issuer-1",
      }),
    ).toBe(false);

    mocks.loadPairing.mockReturnValue(pairedDevice());
    expect(
      capturePluginNotificationPrincipal({
        pluginId: "board",
        client: client({ sharedGatewaySessionGeneration: "issuer-rotated" }),
      }),
    ).toBeUndefined();
    expect(
      capturePluginNotificationPrincipal({
        pluginId: "board",
        client: client({
          connect: { device: { id: "browser-1" }, role: "operator", scopes: ["operator.write"] },
        }),
      }),
    ).toBeUndefined();
  });

  it("keeps a bound principal usable after its request closes, then rejects shared auth rotation and revocation", async () => {
    const device = pairedDevice();
    mocks.loadPairing.mockReturnValue(device);
    const currentClient = client();
    let requiredSharedGatewaySessionGeneration = "issuer-1";
    const principal = capturePluginNotificationPrincipal({
      pluginId: "board",
      client: currentClient,
    });
    const send = vi.fn(async () => "accepted" as const);
    const emitter = createPluginNotificationEmitter({
      declaration: {
        version: 1,
        id: "ready",
        requiredScopes: ["operator.read"],
        destinations: [{ id: "item", tabId: "board" }],
      },
      coordinator: new PluginNotificationCoordinator({
        pluginId: "board",
        declaration: {
          version: 1,
          id: "ready",
          requiredScopes: ["operator.read"],
          destinations: [{ id: "item", tabId: "board" }],
        },
        targets: () => [{ id: "web:browser" }],
        transportSourceId: () => "gateway-test",
        transport: { send, clear: async () => "accepted" },
      }),
      isPluginActive: () => true,
      capturePrincipal: () => principal,
      isPrincipalCurrent: (bound) =>
        isPluginNotificationPrincipalCurrent({
          principal: bound,
          getRequiredSharedGatewaySessionGeneration: () => requiredSharedGatewaySessionGeneration,
        }),
    });
    let binding: ReturnType<typeof emitter.bindCurrentOperator> = undefined;
    await withPluginRuntimeGatewayRequestScope(
      {
        client: currentClient,
        isWebchatConnect: () => false,
      },
      async () => {
        binding = emitter.bindCurrentOperator();
      },
    );

    await expect(
      binding!.emit({
        version: 1,
        emissionId: "event-background",
        logicalOperationId: "operation-background",
        attentionClass: "active",
        preview: { title: "Ready", body: "One item" },
        deepLink: { kind: "plugin-detail", destinationId: "item", recordId: "record-1" },
        expiresAtMs: Date.now() + 60_000,
      }),
    ).resolves.toMatchObject({ status: "sent" });
    expect(send).toHaveBeenCalledTimes(1);

    // A gateway credential rotation changes the host epoch but does not rewrite
    // the paired-device row. The retained binding must be rejected before I/O.
    const pairingBeforeGatewayRotation = JSON.stringify(device);
    requiredSharedGatewaySessionGeneration = "issuer-rotated";
    await expect(
      binding!.emit({
        version: 1,
        emissionId: "event-auth-rotated",
        logicalOperationId: "operation-auth-rotated",
        attentionClass: "active",
        preview: { title: "Ready", body: "One item" },
        deepLink: { kind: "plugin-detail", destinationId: "item", recordId: "record-1" },
        expiresAtMs: Date.now() + 60_000,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(JSON.stringify(device)).toBe(pairingBeforeGatewayRotation);
    expect(send).toHaveBeenCalledTimes(1);

    requiredSharedGatewaySessionGeneration = "issuer-1";
    (device.tokens.operator as { revokedAtMs?: number }).revokedAtMs = Date.now();
    await expect(
      binding!.emit({
        version: 1,
        emissionId: "event-revoked",
        logicalOperationId: "operation-revoked",
        attentionClass: "active",
        preview: { title: "Ready", body: "One item" },
        deepLink: { kind: "plugin-detail", destinationId: "item", recordId: "record-1" },
        expiresAtMs: Date.now() + 60_000,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("discovers separately registered Web and APNs devices after operator credential rotation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-notification-targets-"));
    const browser = pairedDevice();
    const rotatedBrowser = pairedDevice({
      deviceId: "browser-rotated",
      publicKey: "public-key-rotated",
      approvedAtMs: 20,
      tokens: {
        operator: {
          token: "rotated-device-token-secret",
          role: "operator",
          scopes: ["operator.read"],
          createdAtMs: 20,
          rotatedAtMs: 21,
          issuer: { kind: "shared-gateway-auth", generation: "issuer-1" },
        },
      },
    });
    const phone = {
      deviceId: "phone-1",
      publicKey: "phone-public-key",
      approvedAtMs: 30,
      tokens: {
        node: {
          token: "phone-device-token-secret",
          role: "node",
          scopes: [],
          createdAtMs: 30,
          issuer: { kind: "shared-gateway-auth", generation: "issuer-1" },
        },
      },
    };
    mocks.loadPairing.mockImplementation((deviceId: string) => {
      if (deviceId === "browser-1") {
        return browser;
      }
      if (deviceId === "browser-rotated") {
        return rotatedBrowser;
      }
      if (deviceId === "phone-1") {
        return phone;
      }
      return undefined;
    });
    mocks.listSubscriptions.mockReturnValue([{ subscriptionId: "browser-subscription" }]);
    try {
      expect(
        associatePluginNotificationWebTarget({
          subscriptionId: "browser-subscription",
          client: client(),
          stateDir: dir,
        }),
      ).toBe(true);
      expect(
        associatePluginNotificationApnsTarget({
          nodeId: "phone-1",
          client: client({
            connect: { device: { id: "phone-1" }, role: "node", scopes: [] },
          }),
          stateDir: dir,
        }),
      ).toBe(true);

      const rotatedPrincipal = capturePluginNotificationPrincipal({
        pluginId: "board",
        client: client({
          connect: {
            device: { id: "browser-rotated" },
            role: "operator",
            scopes: ["operator.read"],
          },
        }),
      });
      expect(rotatedPrincipal).toBeDefined();
      expect(listPluginNotificationTargets(rotatedPrincipal!, dir, () => "issuer-1")).toEqual([
        { id: "apns:phone-1" },
        { id: "web:browser-subscription" },
      ]);

      (browser.tokens.operator as { revokedAtMs?: number }).revokedAtMs = 40;
      // The new browser can still deliver to independently current devices, but
      // never to a Web Push endpoint whose originally associated device is revoked.
      expect(listPluginNotificationTargets(rotatedPrincipal!, dir, () => "issuer-1")).toEqual([
        { id: "apns:phone-1" },
      ]);
    } finally {
      closeOpenClawStateDatabaseForTest();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("filters stale target associations after shared auth generation rotates", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-notification-target-epoch-"));
    const device = pairedDevice();
    let requiredSharedGatewaySessionGeneration = "issuer-1";
    mocks.loadPairing.mockReturnValue(device);
    mocks.listSubscriptions.mockReturnValue([{ subscriptionId: "browser-subscription" }]);
    try {
      const principal = capturePluginNotificationPrincipal({ pluginId: "board", client: client() });
      expect(principal).toBeDefined();
      expect(
        associatePluginNotificationWebTarget({
          subscriptionId: "browser-subscription",
          client: client(),
          stateDir: dir,
        }),
      ).toBe(true);
      expect(
        listPluginNotificationTargets(
          principal!,
          dir,
          () => requiredSharedGatewaySessionGeneration,
        ),
      ).toEqual([{ id: "web:browser-subscription" }]);

      requiredSharedGatewaySessionGeneration = "issuer-rotated";
      expect(
        isPluginNotificationPrincipalCurrent({
          principal: principal!,
          getRequiredSharedGatewaySessionGeneration: () => requiredSharedGatewaySessionGeneration,
        }),
      ).toBe(false);
      expect(
        listPluginNotificationTargets(
          principal!,
          dir,
          () => requiredSharedGatewaySessionGeneration,
        ),
      ).toEqual([]);
    } finally {
      closeOpenClawStateDatabaseForTest();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("host plugin notification transport", () => {
  it("passes only bounded payload data and a host timeout fence to Web Push", async () => {
    mocks.sendWebPush.mockResolvedValue({
      ok: true,
      subscriptionId: "subscription-1",
      statusCode: 201,
    });
    const controller = new AbortController();
    const transport = createHostPluginNotificationTransport();

    await expect(
      transport.send(
        { id: "web:subscription-1" },
        {
          version: 1,
          kind: "notify",
          sourceId: "gateway-test",
          tag: "operation-tag",
          expiresAtMs: 20_000,
          ttlMs: 5_000,
          preview: { title: "Ready", body: "One item" },
          target: {
            kind: "plugin-detail",
            pluginId: "board",
            tabId: "items",
            destinationId: "item",
            recordId: "record-1",
          },
        },
        { signal: controller.signal, timeoutMs: 5_000 },
      ),
    ).resolves.toBe("accepted");

    expect(mocks.sendWebPush).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: "subscription-1",
        ttlMs: 5_000,
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    );
    const call = mocks.sendWebPush.mock.calls[0]?.[0] as { payload: unknown };
    expect(JSON.stringify(call.payload)).not.toMatch(/vapid|private.?key|token|authorization/i);
  });

  it("sends typed APNs targets and maps definitive responses separately from ambiguity", async () => {
    const transport = createHostPluginNotificationTransport();
    mocks.loadApns.mockResolvedValue({
      transport: "direct",
      nodeId: "phone-1",
      token: "device-token-stays-host-side",
      topic: "ai.openclaw.ios",
      environment: "production",
    });
    mocks.resolveApnsAuth.mockResolvedValue({
      ok: true,
      value: { teamId: "team", keyId: "key", privateKey: "host-private-key" },
    });
    mocks.sendApns.mockResolvedValueOnce({ ok: false, status: 410 }).mockResolvedValueOnce({
      ok: false,
      status: 503,
    });
    const payload = {
      version: 1 as const,
      kind: "notify" as const,
      sourceId: "gateway-test",
      tag: "operation-tag",
      expiresAtMs: 60_000,
      ttlMs: 10_000,
      target: {
        kind: "plugin-detail" as const,
        pluginId: "board",
        tabId: "items",
        destinationId: "item",
        recordId: "record-1",
      },
    };
    const attempt = { signal: new AbortController().signal, timeoutMs: 10_000 };

    await expect(transport.send({ id: "apns:phone-1" }, payload, attempt)).resolves.toBe("failed");
    await expect(transport.send({ id: "apns:phone-1" }, payload, attempt)).resolves.toBe(
      "ambiguous",
    );
    expect(mocks.sendApns).toHaveBeenLastCalledWith(
      expect.objectContaining({
        timeoutMs: 10_000,
        expirationUnixSeconds: 60,
        sourceId: "gateway-test",
        tag: "operation-tag",
        target: payload.target,
      }),
    );
  });

  it("sends a silent APNs clear for an accepted notification", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const transport = createHostPluginNotificationTransport();
    mocks.loadApns.mockResolvedValue({
      transport: "direct",
      nodeId: "phone-1",
      token: "device-token-stays-host-side",
      topic: "ai.openclaw.ios",
      environment: "production",
    });
    mocks.resolveApnsAuth.mockResolvedValue({
      ok: true,
      value: { teamId: "team", keyId: "key", privateKey: "host-private-key" },
    });
    mocks.clearApns.mockResolvedValue({ ok: true, status: 200 });

    try {
      await expect(
        transport.clear(
          { id: "apns:phone-1" },
          {
            version: 1,
            kind: "clear",
            sourceId: "gateway-test",
            tag: "operation-tag",
            expiresAtMs: 60_000,
            ttlMs: 0,
          },
          { signal: new AbortController().signal, timeoutMs: 10_000 },
        ),
      ).resolves.toBe("accepted");
      expect(mocks.clearApns).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "phone-1",
          sourceId: "gateway-test",
          tag: "operation-tag",
          timeoutMs: 10_000,
          expirationUnixSeconds: 86_410,
        }),
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("sends a retained silent APNs clear through the relay", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const transport = createHostPluginNotificationTransport();
    mocks.loadApns.mockResolvedValue({
      transport: "relay",
      nodeId: "phone-1",
      relayHandle: "relay-handle",
      sendGrant: "host-owned-grant",
      installationId: "install-1",
      topic: "ai.openclaw.ios",
      environment: "production",
      relayOrigin: "https://relay.example.test",
    });
    mocks.resolveApnsRelay.mockReturnValue({
      ok: true,
      value: { baseUrl: "https://relay.example.test", timeoutMs: 20_000 },
    });
    mocks.clearApns.mockResolvedValue({ ok: true, status: 202 });

    try {
      await expect(
        transport.clear(
          { id: "apns:phone-1" },
          {
            version: 1,
            kind: "clear",
            sourceId: "gateway-test",
            tag: "operation-tag",
            expiresAtMs: 60_000,
            ttlMs: 0,
          },
          { signal: new AbortController().signal, timeoutMs: 10_000 },
        ),
      ).resolves.toBe("accepted");
      expect(mocks.clearApns).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "phone-1",
          sourceId: "gateway-test",
          tag: "operation-tag",
          expirationUnixSeconds: 86_410,
          relayConfig: { baseUrl: "https://relay.example.test", timeoutMs: 10_000 },
        }),
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("retains an offline Web Push clear for the bounded delivery window", async () => {
    // HTTP acceptance only queues delivery for an offline browser. The fake
    // transport makes the retention window observable without a push service.
    mocks.sendWebPush.mockResolvedValue({
      ok: true,
      subscriptionId: "offline-browser",
      statusCode: 201,
    });
    const transport = createHostPluginNotificationTransport();

    await expect(
      transport.clear(
        { id: "web:offline-browser" },
        {
          version: 1,
          kind: "clear",
          sourceId: "gateway-test",
          tag: "operation-tag",
          expiresAtMs: 60_000,
          ttlMs: 0,
        },
        { signal: new AbortController().signal, timeoutMs: 10_000 },
      ),
    ).resolves.toBe("accepted");

    expect(mocks.sendWebPush).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "offline-browser", ttlMs: 86_400_000 }),
    );
  });
});
