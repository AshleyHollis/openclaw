import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
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
      targetIds: ["web:browser", "web:alternate"],
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
    expect(claim.targetIds).toEqual(["web:alternate", "web:browser"]);
    expect(first.claimEmission({ ...params, declarationId: "other-declaration" })).toEqual({
      kind: "conflict",
    });
    first.completeEmission({
      principal,
      emissionId: params.emissionId,
      result: sent,
      outcomes: new Map([
        ["web:alternate", "accepted"],
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
        declarationId: "other-declaration",
      }),
    ).toEqual({ kind: "conflict" });
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
      targetIds: ["web:browser", "web:alternate"],
      nowMs: 10_000,
    };
    expect(first.claimEmission(emission)).toMatchObject({ kind: "claimed" });
    first.completeEmission({
      principal,
      emissionId: emission.emissionId,
      result: sent,
      outcomes: new Map([
        ["web:browser", "accepted"],
        ["web:alternate", "accepted"],
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
      attemptId: expect.any(String),
      targetIds: ["web:alternate", "web:browser"],
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
      targetIds: ["web:browser", "web:alternate"],
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
        ["web:alternate", "accepted"],
      ]),
      nowMs: 10_001,
    });
    const clearClaim = ledger.claimClear({
      principal,
      logicalOperationId: "operation-1",
      nowMs: 10_002,
    });
    expect(clearClaim).toMatchObject({
      kind: "claimed",
      targetIds: ["web:alternate", "web:browser"],
    });
    if (clearClaim.kind !== "claimed") {
      throw new Error("expected clear claim");
    }
    ledger.completeClear({
      principal,
      logicalOperationId: "operation-1",
      attemptId: clearClaim.attemptId,
      outcomes: new Map([
        ["web:browser", "accepted"],
        ["web:alternate", "accepted"],
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
      targetIds: ["web:browser", "web:alternate"],
      nowMs: 10_000,
    });
    expect(emit.kind).toBe("claimed");
    first.completeEmission({
      principal,
      emissionId: "event-retry",
      result: sent,
      outcomes: new Map([
        ["web:browser", "accepted"],
        ["web:alternate", "accepted"],
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
      attemptId: expect.any(String),
      targetIds: ["web:alternate", "web:browser"],
      clearedTargetIds: [],
    });
    if (initial.kind !== "claimed") {
      throw new Error("expected initial clear claim");
    }
    first.completeClear({
      principal,
      logicalOperationId: "operation-retry",
      attemptId: initial.attemptId,
      outcomes: new Map([
        ["web:alternate", "failed"],
        ["web:browser", "accepted"],
      ]),
      nowMs: 10_003,
    });

    const restarted = new SqlitePluginNotificationLedger({ stateDir: dir });
    const retry = restarted.claimClear({
      principal,
      logicalOperationId: "operation-retry",
      nowMs: 10_004,
    });
    expect(retry).toEqual({
      kind: "claimed",
      attemptId: expect.any(String),
      targetIds: ["web:alternate"],
      clearedTargetIds: ["web:browser"],
    });
    if (retry.kind !== "claimed") {
      throw new Error("expected retry clear claim");
    }
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
      attemptId: retry.attemptId,
      outcomes: new Map([["web:alternate", "accepted"]]),
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
      targetIds: ["web:browser", "web:alternate"],
      nowMs: 10_000,
    };
    expect(first.claimEmission(emission)).toMatchObject({ kind: "claimed" });
    first.completeEmission({
      principal,
      emissionId: emission.emissionId,
      result: sent,
      outcomes: new Map([
        ["web:browser", "accepted"],
        ["web:alternate", "accepted"],
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
      attemptId: expect.any(String),
      targetIds: ["web:alternate", "web:browser"],
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
      attemptId: expect.any(String),
      targetIds: ["web:alternate", "web:browser"],
      clearedTargetIds: [],
    });
  });

  it("upgrades existing clear rows and invalidates old completion before a late-send re-clear claim", async () => {
    const dir = await stateDir();
    const ledger = new SqlitePluginNotificationLedger({ stateDir: dir });
    const logicalOperationId = "operation-upgrade";
    ledger.claimEmission({
      principal,
      declarationId: "ready",
      emissionId: "event-upgrade",
      logicalOperationId,
      candidateHash: "hash-upgrade",
      expiresAtMs: 70_000,
      targetIds: ["web:browser"],
      nowMs: 10_000,
    });
    ledger.claimClear({ principal, logicalOperationId, nowMs: 10_000 });
    // Reconstruct the previously approved additive table shape, retaining its in-flight row.
    const { db } = openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: dir } });
    db.exec("ALTER TABLE plugin_notification_clear_attempts DROP COLUMN attempt_id");
    closeOpenClawStateDatabaseForTest();
    const claim = ledger.claimClear({ principal, logicalOperationId, nowMs: 10_000 });
    if (claim.kind !== "claimed") {
      throw new Error("expected upgraded clear claim");
    }
    ledger.completeEmission({
      principal,
      emissionId: "event-upgrade",
      result: { ...sent, attempted: 1, delivered: 1 },
      outcomes: new Map([["web:browser", "accepted"]]),
      nowMs: 10_000,
    });
    // Another coordinator can complete the old clear between the durable invalidation
    // and the new coordinator's claim. It must not convert that marker into success.
    ledger.completeClear({
      principal,
      logicalOperationId,
      attemptId: claim.attemptId,
      outcomes: new Map([["web:browser", "accepted"]]),
      nowMs: 10_000,
    });
    closeOpenClawStateDatabaseForTest();
    expect(ledger.claimClear({ principal, logicalOperationId, nowMs: 10_000 })).toMatchObject({
      kind: "claimed",
      targetIds: ["web:browser"],
      clearedTargetIds: [],
    });
  });

  it("retries a failed device clear through a new coordinator after restart", async () => {
    const dir = await stateDir();
    const declaration = {
      version: 1 as const,
      id: "ready",
      requiredScopes: ["operator.read" as const],
      destinations: [{ id: "item", pageId: "board" }],
    };
    const clearedTargets: string[] = [];
    let failPhone = true;
    const transport = {
      send: async () => "accepted" as const,
      clear: async (target: { id: string }) => {
        clearedTargets.push(target.id);
        if (target.id === "web:alternate" && failPhone) {
          return "failed" as const;
        }
        return "accepted" as const;
      },
    };
    const createCoordinator = () =>
      new PluginNotificationCoordinator({
        pluginId: "board",
        declaration,
        targets: () => [{ id: "web:browser" }, { id: "web:alternate" }],
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
    expect(clearedTargets).toEqual(["web:alternate", "web:browser"]);

    failPhone = false;
    await expect(
      createCoordinator().clear(principal, {
        version: 1,
        logicalOperationId: candidate.logicalOperationId,
      }),
    ).resolves.toEqual(cleared);
    expect(clearedTargets).toEqual(["web:alternate", "web:browser", "web:alternate"]);
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
        destinations: [{ id: "item", pageId: "board" }],
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

  it.each([false, true])(
    "re-clears a late send despite an older delayed clear response: %s",
    async (delayClear) => {
      const dir = await stateDir();
      let releaseSend: ((outcome: "accepted") => void) | undefined;
      let markSendStarted: (() => void) | undefined;
      const sendStarted = new Promise<void>((resolve) => {
        markSendStarted = resolve;
      });
      const clears: string[] = [];
      const firstClear = Promise.withResolvers<"accepted">();
      const clearStarted = Promise.withResolvers<void>();
      let visible = false;
      const coordinator = new PluginNotificationCoordinator({
        pluginId: "board",
        declaration: {
          version: 1,
          id: "ready",
          requiredScopes: ["operator.read"],
          destinations: [{ id: "item", pageId: "board" }],
        },
        targets: () => [{ id: "web:browser" }],
        transportSourceId: () => "gateway-test",
        transport: {
          send: async () => {
            markSendStarted?.();
            const outcome = await new Promise<"accepted">((resolve) => {
              releaseSend = resolve;
            });
            visible = true;
            return outcome;
          },
          clear: async (target) => {
            clears.push(target.id);
            if (delayClear && clears.length === 2) {
              return "failed" as const;
            }
            visible = false;
            clearStarted.resolve();
            if (delayClear && clears.length === 1) {
              return await firstClear.promise;
            }
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
      const clearing = coordinator.clear(principal, {
        version: 1,
        logicalOperationId: emission.logicalOperationId,
      });
      await clearStarted.promise;
      if (!delayClear) {
        await clearing;
      }
      if (!releaseSend) {
        throw new Error("expected send release");
      }
      releaseSend("accepted");
      await expect(inFlight).resolves.toMatchObject({ status: "sent" });
      expect(clears).toEqual(["web:browser", "web:browser"]);
      firstClear.resolve("accepted");
      await expect(clearing).resolves.toMatchObject({
        status: delayClear ? "partial" : "cleared",
        cleared: delayClear ? 0 : 1,
        failed: delayClear ? 1 : 0,
        ambiguous: 0,
      });
      closeOpenClawStateDatabaseForTest();
      await expect(
        coordinator.clear(principal, {
          version: 1,
          logicalOperationId: emission.logicalOperationId,
        }),
      ).resolves.toMatchObject({ status: "cleared" });
      expect(clears).toHaveLength(delayClear ? 3 : 2);
      expect(visible).toBe(false);
    },
  );
});
