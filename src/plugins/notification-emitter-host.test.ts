import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPairing: vi.fn(),
  listSubscriptions: vi.fn(() => []),
  sendWebPush: vi.fn(),
  loadApns: vi.fn(),
  resolveApnsAuth: vi.fn(),
  resolveApnsRelay: vi.fn(),
  sendApns: vi.fn(),
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
  sendApnsAlert: mocks.sendApns,
}));

import {
  capturePluginNotificationPrincipal,
  createHostPluginNotificationTransport,
  isPluginNotificationPrincipalCurrent,
} from "./notification-emitter-host.js";

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
  it("binds paired auth, issuer generation, revocation, and current scopes without serializing a token", () => {
    const device = pairedDevice();
    mocks.loadPairing.mockReturnValue(device);
    const currentClient = client();
    const principal = capturePluginNotificationPrincipal({ pluginId: "board", client: currentClient });

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
      isPluginNotificationPrincipalCurrent({ principal: principal!, client: currentClient }),
    ).toBe(true);

    (device.tokens.operator as { revokedAtMs?: number }).revokedAtMs = 11;
    expect(
      isPluginNotificationPrincipalCurrent({ principal: principal!, client: currentClient }),
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
        client: client({ connect: { device: { id: "browser-1" }, role: "operator", scopes: ["operator.write"] } }),
      }),
    ).toBeUndefined();
  });
});

describe("host plugin notification transport", () => {
  it("passes only bounded payload data and a host timeout fence to Web Push", async () => {
    mocks.sendWebPush.mockResolvedValue({ ok: true, subscriptionId: "subscription-1", statusCode: 201 });
    const controller = new AbortController();
    const transport = createHostPluginNotificationTransport();

    await expect(
      transport.send(
        { id: "web:subscription-1" },
        {
          version: 1,
          kind: "notify",
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
      expect.objectContaining({ subscriptionId: "subscription-1", ttlMs: 5_000, signal: controller.signal }),
    );
    const call = mocks.sendWebPush.mock.calls[0]?.[0] as { payload: unknown };
    expect(JSON.stringify(call.payload)).not.toMatch(/vapid|private.?key|token|authorization/i);
  });

  it("maps definitive APNs responses separately from ambiguous transport failures", async () => {
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
      tag: "operation-tag",
      expiresAtMs: 60_000,
      ttlMs: 10_000,
    };
    const attempt = { signal: new AbortController().signal, timeoutMs: 10_000 };

    await expect(transport.send({ id: "apns:phone-1" }, payload, attempt)).resolves.toBe("failed");
    await expect(transport.send({ id: "apns:phone-1" }, payload, attempt)).resolves.toBe(
      "ambiguous",
    );
    expect(mocks.sendApns).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 10_000, expirationUnixSeconds: 60 }),
    );
  });
});
