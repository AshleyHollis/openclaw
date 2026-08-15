import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginNotificationPrincipal } from "./notification-emitter.js";
import { SqlitePluginNotificationLedger } from "./notification-emitter-ledger.js";

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
    if (claim.kind !== "claimed") throw new Error("expected one emission claimant");
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
    expect(ledger.claimClear({ principal, logicalOperationId: "operation-1", nowMs: 10_002 })).toMatchObject({
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
});
