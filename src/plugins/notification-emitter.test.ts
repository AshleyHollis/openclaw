import { describe, expect, it } from "vitest";
import {
  PluginNotificationCoordinator,
  validatePluginNotificationCandidate,
  validatePluginNotificationDeclaration,
  type PluginNotificationCandidateV1,
  type PluginNotificationDeclarationV1,
} from "./notification-emitter.js";

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
});
