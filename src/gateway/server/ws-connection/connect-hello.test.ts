import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";

const mocks = vi.hoisted(() => ({
  loadCombinedSessionStoreForGatewayCore: vi.fn(),
}));

vi.mock("../../../config/sessions/combined-store-gateway.js", () => ({
  loadCombinedSessionStoreForGatewayCore: mocks.loadCombinedSessionStoreForGatewayCore,
}));
vi.mock("../../../state/user-profiles.js", () => ({ listProfiles: () => [] }));
vi.mock("../../../version.js", () => ({ resolveRuntimeServiceVersion: () => "test" }));
vi.mock("../../session-sharing.js", () => ({ allowedSessionVisibilities: () => ["shared"] }));
vi.mock("../../ws-log.js", () => ({
  formatForLog: (value: unknown) => String(value),
  logWs: vi.fn(),
}));
vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: () => ({ presence: [], stateVersion: { presence: 0 } }),
  getHealthCache: () => undefined,
  getHealthVersion: () => 0,
}));
vi.mock("./connect-auth-security.js", () => ({ emitGatewayAuthSecurityEvent: vi.fn() }));

import { sendGatewayHello } from "./connect-hello.js";

describe("sendGatewayHello", () => {
  afterEach(() => {
    mocks.loadCombinedSessionStoreForGatewayCore.mockReset();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("puts only durable same-plugin session links into the authenticated tab grant", async () => {
    resetPluginRuntimeStateForTest();
    const registry = createTestRegistry([]);
    registry.controlUiDescriptors = [
      {
        pluginId: "journal",
        descriptor: {
          id: "panel",
          surface: "tab",
          label: "Journal",
          path: "/plugins/journal/panel",
          capabilityBridge: {
            protocolVersion: 1,
            requiredMethods: ["chat.history"],
            optionalMethods: [],
          },
        },
        source: "test:journal",
      },
    ];
    registry.httpRoutes = [
      {
        pluginId: "journal",
        path: "/plugins/journal",
        auth: "gateway",
        match: "prefix",
        source: "test:journal",
        handler: async () => true,
      },
    ];
    setActivePluginRegistry(registry);
    mocks.loadCombinedSessionStoreForGatewayCore.mockReturnValue({
      store: {
        "agent:main:foreign": { pluginOwnerId: "other" },
        "agent:main:owned": { pluginOwnerId: "journal" },
        "agent:main:pending": { initializationPending: true, pluginOwnerId: "journal" },
      },
    });
    const sendFrame = vi.fn(async () => undefined);
    const log = { error: vi.fn(), warn: vi.fn() };

    await sendGatewayHello(
      {
        configSnapshot: {},
        connectParams: { client: { id: "ui", mode: "ui" } },
        frame: { id: "connect" },
        handler: {
          advanceHandshakePhase: vi.fn(),
          buildRequestContext: vi.fn(),
          close: vi.fn(),
          connId: "connection",
          events: [],
          gatewayMethods: ["chat.history"],
          logGateway: log,
          logHealth: log,
          refreshHealthSnapshot: vi.fn(async () => undefined),
          setCloseCause: vi.fn(),
        },
        pendingNodePairingCleanup: {},
        releasePendingNodePairingCleanup: vi.fn(async () => undefined),
        sendFrame,
      } as never,
      {
        authMethod: "token",
        authResult: { ok: true, method: "token" },
        bootstrapDeviceTokens: [],
        controlUiDeviceAuthMigrationPending: false,
        device: null,
        deviceToken: null,
        hasPasswordAuth: false,
        hasTokenAuth: true,
        resolvedAuth: { mode: "token" },
        sessionSharedGatewaySessionGeneration: "token-auth-generation",
        role: "operator",
        scopes: ["operator.read"],
      } as never,
      {},
    );

    expect(mocks.loadCombinedSessionStoreForGatewayCore).toHaveBeenCalledWith(
      {},
      {
        configuredAgentsOnly: true,
        includeIncognito: false,
        projection: "list",
      },
    );
    expect(sendFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        payload: expect.objectContaining({
          controlUiTabs: [
            expect.objectContaining({
              capabilityBridge: expect.objectContaining({
                linkedSessionKeys: ["agent:main:owned"],
              }),
            }),
          ],
        }),
      }),
    );
    expect(sendFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          auth: {
            authorityId: "token-auth-generation",
            role: "operator",
            scopes: ["operator.read"],
          },
        }),
      }),
    );
  });
});
