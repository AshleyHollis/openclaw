import { describe, expect, it, vi } from "vitest";
import {
  createPluginNotificationEmitter,
  PluginNotificationCoordinator,
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
  it("rejects closed malformed candidates and declaration ownership violations", async () => {
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
    const service = new PluginNotificationCoordinator({
      pluginId: "board",
      declaration,
      now: () => 1,
      targets: () => [],
      transportSourceId: () => "gateway-test",
      transport: {
        send: async () => "accepted",
        clear: async () => "accepted",
      },
    });
    expect(
      await service.emit("operator", {
        ...candidate(),
        url: "https://example.test",
      } as PluginNotificationCandidateV1),
    ).toMatchObject({ status: "failed" });
    expect(
      await service.emit("operator", candidate({ preview: { title: "\ud800", body: "body" } })),
    ).toMatchObject({ status: "failed" });
    expect(await service.emit("operator", candidate({ expiresAtMs: 1 }))).toMatchObject({
      status: "failed",
    });
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
    for (let index = 3; index <= 13; index++) {
      await service.emit(
        "operator",
        candidate({ emissionId: `event-${index}`, logicalOperationId: `operation-${index}` }),
      );
    }
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

  it("delivers the bounded snapshot when a plugin mutates its candidate after emit", async () => {
    let releaseTransport: (() => void) | undefined;
    let transportStarted: (() => void) | undefined;
    const transportGate = new Promise<void>((resolve) => {
      releaseTransport = resolve;
    });
    const transportStartedGate = new Promise<void>((resolve) => {
      transportStarted = resolve;
    });
    let deliveredPayload: unknown;
    const service = new PluginNotificationCoordinator({
      pluginId: "board",
      declaration,
      now: () => 1_000,
      targets: () => [{ id: "apns:phone" }],
      transportSourceId: () => "gateway-test",
      transport: {
        send: async (_target, payload) => {
          transportStarted?.();
          await transportGate;
          deliveredPayload = payload;
          return "accepted";
        },
        clear: async () => "accepted",
      },
    });
    const mutable = candidate();
    const emission = service.emit("operator", mutable);

    await transportStartedGate;
    mutable.preview.title = "x".repeat(81);
    mutable.preview.body = "y".repeat(257);
    mutable.deepLink.destinationId = "foreign";
    mutable.deepLink.recordId = "other-record";
    mutable.expiresAtMs = 1;
    releaseTransport?.();

    await expect(emission).resolves.toMatchObject({ status: "sent" });
    expect(deliveredPayload).toMatchObject({
      expiresAtMs: 100_000,
      preview: { title: "Ready", body: "One item is ready" },
      target: { destinationId: "item", recordId: "record-1" },
    });
  });

  it("samples accessor-backed candidates once before validating and delivering them", async () => {
    let titleReads = 0;
    let recordIdReads = 0;
    let expiryReads = 0;
    const preview: Record<string, unknown> = { body: "One item is ready" };
    Object.defineProperty(preview, "title", {
      enumerable: true,
      get: () => {
        titleReads += 1;
        return titleReads === 1 ? "Ready" : "x".repeat(81);
      },
    });
    const deepLink: Record<string, unknown> = { kind: "plugin-detail", destinationId: "item" };
    Object.defineProperty(deepLink, "recordId", {
      enumerable: true,
      get: () => {
        recordIdReads += 1;
        return recordIdReads === 1 ? "record-1" : "other-record";
      },
    });
    const accessorCandidate: Record<string, unknown> = {
      version: 1,
      emissionId: "event-accessor",
      logicalOperationId: "operation-accessor",
      attentionClass: "active",
      preview,
      deepLink,
    };
    Object.defineProperty(accessorCandidate, "expiresAtMs", {
      enumerable: true,
      get: () => {
        expiryReads += 1;
        return expiryReads === 1 ? 100_000 : 1;
      },
    });
    let deliveredPayload: unknown;
    const service = new PluginNotificationCoordinator({
      pluginId: "board",
      declaration,
      now: () => 1_000,
      targets: () => [{ id: "web" }],
      transportSourceId: () => "gateway-test",
      transport: {
        send: async (_target, payload) => {
          deliveredPayload = payload;
          return "accepted";
        },
        clear: async () => "accepted",
      },
    });

    await expect(service.emit("operator", accessorCandidate)).resolves.toMatchObject({
      status: "sent",
    });
    expect({ titleReads, recordIdReads, expiryReads }).toEqual({
      titleReads: 1,
      recordIdReads: 1,
      expiryReads: 1,
    });
    expect(deliveredPayload).toMatchObject({
      expiresAtMs: 100_000,
      preview: { title: "Ready", body: "One item is ready" },
      target: { destinationId: "item", recordId: "record-1" },
    });
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
