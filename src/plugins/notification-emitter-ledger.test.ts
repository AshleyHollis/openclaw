import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { SqlitePluginNotificationLedger } from "./notification-emitter-ledger.js";
import {
  PluginNotificationCoordinator,
  type PluginNotificationPrincipal,
} from "./notification-emitter.js";

const stateDirs: string[] = [];
const principal: PluginNotificationPrincipal = {
  operatorId: "operator@example.test",
  pluginId: "board",
  authenticationMethod: "device-token",
  authenticationGeneration: "auth-generation-1",
  pairedDeviceId: "browser-1",
  pairingGeneration: "pairing-generation-1",
  issuerGeneration: "issuer-generation-1",
  scopes: ["operator.read"],
};
const sent = { status: "sent", attempted: 2, delivered: 2, failed: 0, ambiguous: 0 } as const;
const cleared = { status: "cleared", attempted: 2, cleared: 2, failed: 0, ambiguous: 0 } as const;

async function stateDir(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "openclaw-notification-ledger-"));
  stateDirs.push(value);
  return value;
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(stateDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("plugin notification SQLite ledger", () => {
  it("claims one logical emission across concurrent coordinators and replays after restart", async () => {
    const dir = await stateDir();
    const first = new SqlitePluginNotificationLedger({ stateDir: dir });
    const params = {
      principal,
      declarationId: "ready",
      emissionId: "event-1",
      logicalOperationId: "operation-1",
      candidateHash: "candidate-hash-1",
      expiresAtMs: 1_000_000,
      targetIds: ["web:browser", "apns:phone"],
      nowMs: 10_000,
    };
    const [owner, follower] = await Promise.all([
      Promise.resolve(first.claimEmission(params)),
      Promise.resolve(new SqlitePluginNotificationLedger({ stateDir: dir }).claimEmission(params)),
    ]);
    expect([owner.kind, follower.kind].toSorted()).toEqual(["claimed", "in-flight"]);
    const claim = owner.kind === "claimed" ? owner : follower;
    if (claim.kind !== "claimed") {
      throw new Error("expected one emission claimant");
    }
    expect(claim.targetIds).toEqual(["apns:phone", "web:browser"]);
    first.completeEmission({
      principal,
      emissionId: params.emissionId,
      result: sent,
      outcomes: new Map([
        ["apns:phone", "accepted"],
        ["web:browser", "accepted"],
      ]),
      nowMs: 10_001,
    });
    expect(new SqlitePluginNotificationLedger({ stateDir: dir }).claimEmission(params)).toEqual({
      kind: "replay",
      result: sent,
    });
    expect(
      new SqlitePluginNotificationLedger({ stateDir: dir }).claimEmission({
        ...params,
        candidateHash: "changed-candidate-hash",
      }),
    ).toEqual({ kind: "conflict" });
  });

  it("keeps duplicate suppression and clearing with the operator after credential rotation", async () => {
    const dir = await stateDir();
    const first = new SqlitePluginNotificationLedger({ stateDir: dir });
    const rotatedPrincipal: PluginNotificationPrincipal = {
      ...principal,
      authenticationGeneration: "auth-generation-2",
      pairedDeviceId: "browser-2",
      pairingGeneration: "pairing-generation-2",
      issuerGeneration: "issuer-generation-2",
    };
    const emission = {
      principal,
      declarationId: "ready",
      emissionId: "event-rotation",
      logicalOperationId: "operation-rotation",
      candidateHash: "hash-rotation",
      expiresAtMs: 1_000_000,
      targetIds: ["web:browser", "apns:phone"],
      nowMs: 10_000,
    };
    expect(first.claimEmission(emission)).toMatchObject({ kind: "claimed" });
    first.completeEmission({
      principal,
      emissionId: emission.emissionId,
      result: sent,
      outcomes: new Map([
        ["web:browser", "accepted"],
        ["apns:phone", "accepted"],
      ]),
      nowMs: 10_001,
    });

    const restarted = new SqlitePluginNotificationLedger({ stateDir: dir });
    expect(restarted.claimEmission({ ...emission, principal: rotatedPrincipal })).toEqual({
      kind: "replay",
      result: sent,
    });
    expect(
      restarted.claimClear({
        principal: rotatedPrincipal,
        logicalOperationId: emission.logicalOperationId,
        nowMs: 10_002,
      }),
    ).toEqual({
      kind: "claimed",
      targetIds: ["apns:phone", "web:browser"],
      clearedTargetIds: [],
    });
  });

  it("persists cross-device clearing, rate windows, and retention boundaries", async () => {
    const dir = await stateDir();
    const ledger = new SqlitePluginNotificationLedger({ stateDir: dir });
    const base = {
      principal,
      declarationId: "ready",
      logicalOperationId: "operation-1",
      expiresAtMs: 1_000_000,
      targetIds: ["web:browser", "apns:phone"],
      nowMs: 10_000,
    };
    const claim = ledger.claimEmission({ ...base, emissionId: "event-1", candidateHash: "hash-1" });
    expect(claim.kind).toBe("claimed");
    ledger.completeEmission({
      principal,
      emissionId: "event-1",
      result: sent,
      outcomes: new Map([
        ["web:browser", "accepted"],
        ["apns:phone", "accepted"],
      ]),
      nowMs: 10_001,
    });
    expect(
      ledger.claimClear({ principal, logicalOperationId: "operation-1", nowMs: 10_002 }),
    ).toMatchObject({
      kind: "claimed",
      targetIds: ["apns:phone", "web:browser"],
    });
    ledger.completeClear({
      principal,
      logicalOperationId: "operation-1",
      result: cleared,
      outcomes: new Map([
        ["web:browser", "accepted"],
        ["apns:phone", "accepted"],
      ]),
      nowMs: 10_003,
    });
    expect(
      new SqlitePluginNotificationLedger({ stateDir: dir }).claimClear({
        principal,
        logicalOperationId: "operation-1",
        nowMs: 10_004,
      }),
    ).toEqual({ kind: "replay", result: cleared });

    for (let index = 2; index <= 12; index += 1) {
      const claimed = ledger.claimEmission({
        ...base,
        emissionId: `event-${index}`,
        logicalOperationId: `operation-${index}`,
        candidateHash: `hash-${index}`,
      });
      expect(claimed.kind).toBe("claimed");
      ledger.completeEmission({
        principal,
        emissionId: `event-${index}`,
        result: { status: "no-targets", attempted: 0, delivered: 0, failed: 0, ambiguous: 0 },
        outcomes: new Map(),
        nowMs: 10_001,
      });
    }
    expect(
      ledger.claimEmission({
        ...base,
        emissionId: "event-13",
        logicalOperationId: "operation-13",
        candidateHash: "hash-13",
      }),
    ).toMatchObject({ kind: "rate-limited" });
    const afterRetention = 10_003 + 31 * 86_400_000;
    expect(
      new SqlitePluginNotificationLedger({ stateDir: dir }).claimEmission({
        ...base,
        emissionId: "event-1",
        candidateHash: "hash-1",
        expiresAtMs: afterRetention + 1_000,
        nowMs: afterRetention,
      }),
    ).toMatchObject({ kind: "claimed" });
  });

  it("retries only unresolved clear targets after a partial clear and restart", async () => {
    const dir = await stateDir();
    const first = new SqlitePluginNotificationLedger({ stateDir: dir });
    const emit = first.claimEmission({
      principal,
      declarationId: "ready",
      emissionId: "event-retry",
      logicalOperationId: "operation-retry",
      candidateHash: "hash-retry",
      expiresAtMs: 1_000_000,
      targetIds: ["web:browser", "apns:phone"],
      nowMs: 10_000,
    });
    expect(emit.kind).toBe("claimed");
    first.completeEmission({
      principal,
      emissionId: "event-retry",
      result: sent,
      outcomes: new Map([
        ["web:browser", "accepted"],
        ["apns:phone", "accepted"],
      ]),
      nowMs: 10_001,
    });

    const initial = first.claimClear({
      principal,
      logicalOperationId: "operation-retry",
      nowMs: 10_002,
    });
    expect(initial).toEqual({
      kind: "claimed",
      targetIds: ["apns:phone", "web:browser"],
      clearedTargetIds: [],
    });
    first.completeClear({
      principal,
      logicalOperationId: "operation-retry",
      result: { status: "partial", attempted: 2, cleared: 1, failed: 1, ambiguous: 0 },
      outcomes: new Map([
        ["apns:phone", "failed"],
        ["web:browser", "accepted"],
      ]),
      nowMs: 10_003,
    });

    const restarted = new SqlitePluginNotificationLedger({ stateDir: dir });
    expect(
      restarted.claimClear({
        principal,
        logicalOperationId: "operation-retry",
        nowMs: 10_004,
      }),
    ).toEqual({
      kind: "claimed",
      targetIds: ["apns:phone"],
      clearedTargetIds: ["web:browser"],
    });
    const finalResult = {
      status: "cleared",
      attempted: 2,
      cleared: 2,
      failed: 0,
      ambiguous: 0,
    } as const;
    restarted.completeClear({
      principal,
      logicalOperationId: "operation-retry",
      result: finalResult,
      outcomes: new Map([["apns:phone", "accepted"]]),
      nowMs: 10_005,
    });
    expect(
      new SqlitePluginNotificationLedger({ stateDir: dir }).claimClear({
        principal,
        logicalOperationId: "operation-retry",
        nowMs: 10_006,
      }),
    ).toEqual({ kind: "replay", result: finalResult });
  });

  it("reclaims clear attempts left in flight when the host restarts", async () => {
    const dir = await stateDir();
    const first = new SqlitePluginNotificationLedger({ stateDir: dir });
    const emission = {
      principal,
      declarationId: "ready",
      emissionId: "event-crash-recovery",
      logicalOperationId: "operation-crash-recovery",
      candidateHash: "hash-crash-recovery",
      expiresAtMs: 1_000_000,
      targetIds: ["web:browser", "apns:phone"],
      nowMs: 10_000,
    };
    expect(first.claimEmission(emission)).toMatchObject({ kind: "claimed" });
    first.completeEmission({
      principal,
      emissionId: emission.emissionId,
      result: sent,
      outcomes: new Map([
        ["web:browser", "accepted"],
        ["apns:phone", "accepted"],
      ]),
      nowMs: 10_001,
    });

    // Simulate process loss after the durable claim but before transport I/O completes.
    expect(
      first.claimClear({
        principal,
        logicalOperationId: emission.logicalOperationId,
        nowMs: 10_002,
      }),
    ).toEqual({
      kind: "claimed",
      targetIds: ["apns:phone", "web:browser"],
      clearedTargetIds: [],
    });

    expect(
      new SqlitePluginNotificationLedger({ stateDir: dir }).claimClear({
        principal,
        logicalOperationId: emission.logicalOperationId,
        nowMs: 10_003,
      }),
    ).toEqual({
      kind: "claimed",
      targetIds: ["apns:phone", "web:browser"],
      clearedTargetIds: [],
    });
  });

  it("retries a failed device clear through a new coordinator after restart", async () => {
    const dir = await stateDir();
    const declaration = {
      version: 1 as const,
      id: "ready",
      requiredScopes: ["operator.read" as const],
      destinations: [{ id: "item", tabId: "board" }],
    };
    const clearedTargets: string[] = [];
    let failPhone = true;
    const transport = {
      send: async () => "accepted" as const,
      clear: async (target: { id: string }) => {
        clearedTargets.push(target.id);
        if (target.id === "apns:phone" && failPhone) {
          return "failed" as const;
        }
        return "accepted" as const;
      },
    };
    const createCoordinator = () =>
      new PluginNotificationCoordinator({
        pluginId: "board",
        declaration,
        targets: () => [{ id: "web:browser" }, { id: "apns:phone" }],
        transportSourceId: () => "gateway-test",
        transport,
        ledger: new SqlitePluginNotificationLedger({ stateDir: dir }),
        now: () => 10_000,
      });
    const candidate = {
      version: 1 as const,
      emissionId: "event-transport-retry",
      logicalOperationId: "operation-transport-retry",
      attentionClass: "active" as const,
      preview: { title: "Ready", body: "One item" },
      deepLink: { kind: "plugin-detail" as const, destinationId: "item", recordId: "record-1" },
      expiresAtMs: 70_000,
    };

    await expect(createCoordinator().emit(principal, candidate)).resolves.toEqual(sent);
    await expect(
      createCoordinator().clear(principal, {
        version: 1,
        logicalOperationId: candidate.logicalOperationId,
      }),
    ).resolves.toEqual({ status: "partial", attempted: 2, cleared: 1, failed: 1, ambiguous: 0 });
    expect(clearedTargets).toEqual(["apns:phone", "web:browser"]);

    failPhone = false;
    await expect(
      createCoordinator().clear(principal, {
        version: 1,
        logicalOperationId: candidate.logicalOperationId,
      }),
    ).resolves.toEqual(cleared);
    expect(clearedTargets).toEqual(["apns:phone", "web:browser", "apns:phone"]);
  });

  it("suppresses emissions created after a durable clear tombstone", async () => {
    const dir = await stateDir();
    const sends: string[] = [];
    const clears: string[] = [];
    const coordinator = new PluginNotificationCoordinator({
      pluginId: "board",
      declaration: {
        version: 1,
        id: "ready",
        requiredScopes: ["operator.read"],
        destinations: [{ id: "item", tabId: "board" }],
      },
      targets: () => [{ id: "web:browser" }],
      transportSourceId: () => "gateway-test",
      transport: {
        send: async (target) => {
          sends.push(target.id);
          return "accepted" as const;
        },
        clear: async (target) => {
          clears.push(target.id);
          return "accepted" as const;
        },
      },
      ledger: new SqlitePluginNotificationLedger({ stateDir: dir }),
      now: () => 10_000,
    });
    const first = {
      version: 1 as const,
      emissionId: "event-before-clear",
      logicalOperationId: "operation-cleared",
      attentionClass: "active" as const,
      preview: { title: "Ready", body: "One item" },
      deepLink: { kind: "plugin-detail" as const, destinationId: "item", recordId: "record-1" },
      expiresAtMs: 70_000,
    };

    await expect(coordinator.emit(principal, first)).resolves.toMatchObject({ status: "sent" });
    await expect(
      coordinator.clear(principal, { version: 1, logicalOperationId: first.logicalOperationId }),
    ).resolves.toMatchObject({ status: "cleared" });
    await expect(
      coordinator.emit(principal, { ...first, emissionId: "event-after-clear" }),
    ).resolves.toEqual({
      status: "suppressed",
      attempted: 0,
      delivered: 0,
      failed: 0,
      ambiguous: 0,
    });
    expect(sends).toEqual(["web:browser"]);
    expect(clears).toEqual(["web:browser"]);
  });

  it("re-clears a send that completes after its logical operation was cleared", async () => {
    const dir = await stateDir();
    let releaseSend: ((outcome: "accepted") => void) | undefined;
    let markSendStarted: (() => void) | undefined;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const clears: string[] = [];
    const coordinator = new PluginNotificationCoordinator({
      pluginId: "board",
      declaration: {
        version: 1,
        id: "ready",
        requiredScopes: ["operator.read"],
        destinations: [{ id: "item", tabId: "board" }],
      },
      targets: () => [{ id: "web:browser" }],
      transportSourceId: () => "gateway-test",
      transport: {
        send: async () => {
          markSendStarted?.();
          return await new Promise<"accepted">((resolve) => {
            releaseSend = resolve;
          });
        },
        clear: async (target) => {
          clears.push(target.id);
          return "accepted" as const;
        },
      },
      ledger: new SqlitePluginNotificationLedger({ stateDir: dir }),
      now: () => 10_000,
    });
    const emission = {
      version: 1 as const,
      emissionId: "event-race",
      logicalOperationId: "operation-race",
      attentionClass: "active" as const,
      preview: { title: "Ready", body: "One item" },
      deepLink: { kind: "plugin-detail" as const, destinationId: "item", recordId: "record-1" },
      expiresAtMs: 70_000,
    };

    const inFlight = coordinator.emit(principal, emission);
    await sendStarted;
    await expect(
      coordinator.clear(principal, { version: 1, logicalOperationId: emission.logicalOperationId }),
    ).resolves.toMatchObject({ status: "cleared" });
    if (!releaseSend) {
      throw new Error("expected send release");
    }
    releaseSend("accepted");
    await expect(inFlight).resolves.toMatchObject({ status: "sent" });
    expect(clears).toEqual(["web:browser", "web:browser"]);
    await expect(
      coordinator.clear(principal, { version: 1, logicalOperationId: emission.logicalOperationId }),
    ).resolves.toMatchObject({ status: "cleared" });
    expect(clears).toEqual(["web:browser", "web:browser"]);
  });
});
