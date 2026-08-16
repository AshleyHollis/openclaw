import type { GatewayHelloOk } from "../../api/gateway.ts";

export type ExternalTabBridgeGrant = NonNullable<
  NonNullable<GatewayHelloOk["controlUiTabs"]>[number]["capabilityBridge"]
>;

export function externalTabBridgeGrant(
  overrides: Partial<ExternalTabBridgeGrant> = {},
): ExternalTabBridgeGrant {
  return {
    protocolVersion: 1,
    mode: "read-only",
    methods: ["chat.history"],
    readMethods: ["chat.history"],
    missingRequiredMethods: [],
    upgradeRequired: false,
    linkedSessionKeys: ["agent:main:owned"],
    limits: {
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 1024 * 1024,
      maxConcurrentRequests: 8,
      maxRequestsPerMinute: 60,
      maxMutationsPerMinute: 12,
      handshakeTimeoutMs: 10_000,
      requestTimeoutMs: 30_000,
    },
    ...overrides,
  };
}
