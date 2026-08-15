import { describe, expect, it, vi } from "vitest";
import {
  createPluginNotificationEmitter,
  PluginNotificationCoordinator,
  validatePluginNotificationCandidate,
  validatePluginNotificationDeclaration,
  type PluginNotificationCandidateV1,
  type PluginNotificationDeclarationV1,
} from "./notification-emitter.js";
import { withPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

const declaration: PluginNotificationDeclarationV1 = {
  version: 1,
  id: "ready",
  requiredScopes: ["operator.read"],
  destinations: [{ id: "item", tabId: "board" }],
};
const candidate = (
  patch: Partial<PluginNotificationCandidateV1> = {},
): PluginNotificationCandidateV1 => ({
  version: 1,
  emissionId: "event-1",
  logicalOperationId: "operation-1",
  attentionClass: "active",
  preview: { title: "Ready", body: "One item is ready" },
  deepLink: { kind: "plugin-detail", destinationId: "item", recordId: "record-1" },
  expiresAtMs: 100_000,
  ...patch,
});

describe("plugin notification emitter", () => {
  it("rejects closed malformed candidates and declaration ownership violations", () => {
    expect(
      validatePluginNotificationDeclaration(declaration, {
        pluginId: "board",
        existingCount: 0,
        resolveTab: (id, tab) => id === "board" && tab === "board",
      }),
    ).toBe(true);
    expect(
      validatePluginNotificationDeclaration(
        { ...declaration, destinations: [{ id: "item", tabId: "foreign" }] },
        { pluginId: "board", existingCount: 0, resolveTab: () => false },
      ),
    ).toBe(false);
    expect(
      validatePluginNotificationCandidate(
        { ...candidate(), url: "https://example.test" },
        declaration,
        1,
      ),
    ).toBe(false);
    expect(
      validatePluginNotificationCandidate(
        candidate({ preview: { title: "\ud800", body: "body" } }),
        declaration,
        1,
      ),
    ).toBe(false);
    expect(validatePluginNotificationCandidate(candidate({ expiresAtMs: 1 }), declaration, 1)).toBe(
      false,
    );
  });
  it("deduplicates, prevents identity conflicts, rate limits, unions targets, and classifies ambiguity", async () => {
    let now = 1_000;
    const sends: string[] = [];
    const clears: string[] = [];
    let targets = [{ id: "web" }];
    const service = new PluginNotificationCoordinator({
      pluginId: "board",
      declaration,
      now: () => now,
      targets: () => targets,
      transportSourceId: () => "gateway-test",
      transport: {
        send: async (target) => {
          sends.push(target.id);
          return target.id === "ios" ? "ambiguous" : "accepted";
        },
        clear: async (target) => {
          clears.push(target.id);
          return "accepted";
        },
      },
    });
    expect(await service.emit("operator", candidate())).toMatchObject({
      status: "sent",
      delivered: 1,
    });
    expect(await service.emit("operator", candidate())).toMatchObject({ status: "sent" });
    expect(sends).toEqual(["web"]);
    expect(
      await service.emit("operator", candidate({ preview: { title: "changed", body: "body" } })),
    ).toMatchObject({ status: "failed" });
    targets = [{ id: "ios" }];
    expect(await service.emit("operator", candidate({ emissionId: "event-2" }))).toMatchObject({
      status: "ambiguous",
    });
    expect(
      await service.clear("operator", { version: 1, logicalOperationId: "operation-1" }),
    ).toMatchObject({ status: "cleared", attempted: 2 });
    expect(clears).toEqual(["web", "ios"]);
    for (let index = 3; index <= 13; index++)
      await service.emit(
        "operator",
        candidate({ emissionId: `event-${index}`, logicalOperationId: `operation-${index}` }),
      );
    expect(
      await service.emit(
        "operator",
        candidate({ emissionId: "event-14", logicalOperationId: "operation-14" }),
      ),
    ).toMatchObject({ status: "rate-limited" });
    now += 60_001;
    expect(
      await service.emit(
        "operator",
        candidate({
          emissionId: "event-next",
          logicalOperationId: "operation-next",
          expiresAtMs: now + 1000,
        }),
      ),
    ).not.toMatchObject({ status: "rate-limited" });
  });

  it("isolates matching operations from separate gateway installations", async () => {
    const operations = await Promise.all(
      [
        { operatorId: "gateway:default-operator", pluginId: "board", sourceId: "gateway-a" },
        { operatorId: "gateway:default-operator", pluginId: "board", sourceId: "gateway-b" },
        { operatorId: "operator-a", pluginId: "inbox", sourceId: "gateway-a" },
        { operatorId: "operator-b", pluginId: "board", sourceId: "gateway-a" },
      ].map(async ({ operatorId, pluginId, sourceId }) => {
        let notifyTag: string | undefined;
        let clearTag: string | undefined;
        let notifySourceId: string | undefined;
        let clearSourceId: string | undefined;
        const principal = {
          operatorId,
          pluginId,
          authenticationMethod: "device-token" as const,
          authenticationGeneration: `auth-${operatorId}`,
          pairedDeviceId: `device-${operatorId}`,
          pairingGeneration: `pair-${operatorId}`,
          scopes: ["operator.read"] as const,
        };
        const service = new PluginNotificationCoordinator({
          pluginId,
          declaration,
          now: () => 1_000,
          targets: () => [{ id: "web" }],
          transportSourceId: () => sourceId,
          transport: {
            send: async (_target, payload) => {
              notifyTag = payload.tag;
              notifySourceId = payload.sourceId;
              return "accepted" as const;
            },
            clear: async (_target, payload) => {
              clearTag = payload.tag;
              clearSourceId = payload.sourceId;
              return "accepted" as const;
            },
          },
        });

        await expect(
          service.emit(principal, candidate({ emissionId: `event-${pluginId}-${operatorId}` })),
        ).resolves.toMatchObject({ status: "sent" });
        await expect(
          service.clear(principal, { version: 1, logicalOperationId: "operation-1" }),
        ).resolves.toMatchObject({ status: "cleared" });
        expect(clearTag).toBe(notifyTag);
        expect(clearSourceId).toBe(notifySourceId);
        return { tag: notifyTag, sourceId: notifySourceId };
      }),
    );

    expect(operations[0]).toMatchObject({ sourceId: "gateway-a" });
    expect(operations[1]).toMatchObject({ sourceId: "gateway-b" });
    expect(operations[0]?.tag).not.toBe(operations[1]?.tag);
    expect(new Set(operations.map((operation) => operation.tag)).size).toBe(4);
  });

  it("rechecks the captured authenticated principal before an emission can reach transport", async () => {
    let current = true;
    const send = vi.fn(async () => "accepted" as const);
    const principal = {
      operatorId: "operator",
      pluginId: "board",
      authenticationMethod: "device-token" as const,
      authenticationGeneration: "auth-1",
      pairedDeviceId: "device-1",
      pairingGeneration: "pair-1",
      scopes: ["operator.read"] as const,
    };
    const emitter = createPluginNotificationEmitter({
      declaration,
      coordinator: new PluginNotificationCoordinator({
        pluginId: "board",
        declaration,
        targets: () => [{ id: "web" }],
        transportSourceId: () => "gateway-test",
        transport: { send, clear: async () => "accepted" },
      }),
      isPluginActive: () => true,
      capturePrincipal: () => principal,
      isPrincipalCurrent: () => current,
    });
    await withPluginRuntimeGatewayRequestScope(
      {
        client: {
          authenticatedUserId: "operator",
          connect: { scopes: ["operator.read"] },
        } as never,
        isWebchatConnect: () => false,
      },
      async () => {
        const binding = emitter.bindCurrentOperator();
        expect(binding).toBeDefined();
        current = false;
        await expect(binding!.emit(candidate())).resolves.toMatchObject({ status: "failed" });
      },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("bounds an in-flight send by the candidate expiry and records timeout ambiguity", async () => {
    let now = 1_000;
    let timeoutMs = 0;
    const service = new PluginNotificationCoordinator({
      pluginId: "board",
      declaration,
      now: () => now,
      targets: () => [{ id: "web" }],
      transportSourceId: () => "gateway-test",
      transport: {
        send: async (_target, _payload, options) => {
          timeoutMs = options.timeoutMs;
          return await new Promise<"accepted">(() => {});
        },
        clear: async () => "accepted",
      },
    });
    await expect(
      service.emit("operator", candidate({ expiresAtMs: now + 15 })),
    ).resolves.toMatchObject({
      status: "ambiguous",
      ambiguous: 1,
    });
    expect(timeoutMs).toBe(15);
    now += 16;
  });
});
