import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEffectiveWebPushPreferences } from "../infra/push-web-preferences.js";
import { sendPrivateWebPushForRequester } from "./server-plugin-web-push.js";

const mocks = vi.hoisted(() => {
  const plugin = { id: "test-plugin" };
  return {
    plugin,
    scope: {
      pluginId: plugin.id,
      pluginRegistry: { plugins: [plugin] },
      client: {
        authenticatedUserProfile: { profileId: "profile-a" },
        connect: { role: "operator", scopes: ["operator.write"] },
      },
      gatewayMethodDispatchAllowed: true,
      hasCurrentClientAuthority: vi.fn(() => true),
    },
    active: vi.fn(() => true),
    delivery: vi.fn(async (_request: unknown) => [{ ok: true }]),
    targets: vi.fn<() => unknown[]>(),
  };
});

vi.mock("../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: () => mocks.scope,
}));
vi.mock("../plugins/registry-lifecycle.js", () => ({
  capturePluginLifecycleAuthority: () => mocks.active,
}));
vi.mock("./server-plugin-in-process-dispatch.js", () => ({
  getInProcessGatewayRequestContext: () => ({ getRuntimeConfig: () => ({}) }),
}));
vi.mock("../infra/push-web.js", () => ({
  prepareWebPushNotificationSender: async () => mocks.delivery,
}));
vi.mock("./web-push-authority.js", () => ({
  listCurrentWebPushTargets: mocks.targets,
  withCurrentWebPushAuthority: async (
    params: { preparePublication: () => Promise<void> },
    prepare: (authority: unknown) => { start: () => unknown } | undefined,
  ) => {
    await params.preparePublication();
    return prepare({
      cfg: {},
      profile: { readCurrentIdentity: (profileId: string) => ({ profileId }) },
    })?.start();
  },
}));

function browser(profileId: string, deviceId: string, enabled = true) {
  return {
    userProfileId: profileId,
    subscription: { deviceId },
    preferences: resolveEffectiveWebPushPreferences({ device: { enabled } }),
  };
}

describe("plugin private Web Push", () => {
  const recordId = "b33dad95-b733-437e-9db2-aa087bf83dcb";
  const target = () => ({
    pageId: "attention",
    recordId,
    expiresAtMs: Date.now() + 60_000,
  });
  const publication = () => ({ prepare: vi.fn(async () => {}), claim: vi.fn(() => true) });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scope.hasCurrentClientAuthority.mockReturnValue(true);
    mocks.active.mockReturnValue(true);
    mocks.targets.mockReturnValue([browser("profile-a", "phone")]);
  });

  it("uses only enabled subscriptions on the current profile and builds a private same-plugin route", async () => {
    mocks.targets.mockReturnValue([
      browser("profile-b", "foreign"),
      browser("profile-a", "muted", false),
      browser("profile-a", "phone"),
    ]);
    const publish = publication();
    await expect(sendPrivateWebPushForRequester(target(), publish)).resolves.toEqual({
      attempted: 1,
      accepted: 1,
    });
    expect(publish.claim).toHaveBeenCalledOnce();
    expect(mocks.delivery).toHaveBeenCalledOnce();
    expect(mocks.delivery).toHaveBeenCalledWith({
      subscriptions: [{ deviceId: "phone" }],
      payload: {
        title: "OpenClaw",
        body: "An item needs your attention.",
        url: `plugin?plugin=test-plugin&id=attention&p.notificationRecord=${recordId}`,
        tag: `plugin:test-plugin:${recordId}`,
        renotify: false,
      },
      deliveryOptions: {
        TTL: expect.any(Number),
        urgency: "high",
        topic: recordId.replaceAll("-", ""),
      },
    });
  });

  it("checks caller and plugin authority again after asynchronous publication preparation", async () => {
    for (const current of [mocks.scope.hasCurrentClientAuthority, mocks.active]) {
      const publish = publication();
      publish.prepare.mockImplementationOnce(async () => void current.mockReturnValue(false));
      await expect(sendPrivateWebPushForRequester(target(), publish)).rejects.toThrow(
        "requester authority is no longer current",
      );
      expect(publish.claim).not.toHaveBeenCalled();
      expect(mocks.delivery).not.toHaveBeenCalled();
      current.mockReturnValue(true);
    }
  });

  it("keeps expired, unclaimed and unsubscribed records quiet", async () => {
    const publish = publication();
    const empty = { attempted: 0, accepted: 0 };
    await expect(
      sendPrivateWebPushForRequester({ ...target(), expiresAtMs: Date.now() }, publish),
    ).resolves.toEqual(empty);
    expect(publish.prepare).not.toHaveBeenCalled();
    publish.claim.mockReturnValueOnce(false);
    await expect(sendPrivateWebPushForRequester(target(), publish)).resolves.toEqual(empty);
    mocks.targets.mockReturnValue([]);
    await expect(sendPrivateWebPushForRequester(target(), publish)).resolves.toEqual(empty);
    expect(publish.claim).toHaveBeenCalledOnce();
    expect(mocks.delivery).not.toHaveBeenCalled();
  });

  it("rejects free-form destinations before preparation", async () => {
    const publish = publication();
    await expect(
      sendPrivateWebPushForRequester({ ...target(), pageId: "https://example.invalid/" }, publish),
    ).rejects.toThrow("exact plugin page");
    expect(publish.prepare).not.toHaveBeenCalled();
    expect(mocks.delivery).not.toHaveBeenCalled();
  });
});
