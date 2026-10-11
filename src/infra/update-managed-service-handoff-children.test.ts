import { describe, expect, it } from "vitest";
import { managedCommandCustody } from "./update-managed-service-handoff-children.js";
import type { ManagedHandoffLeasePayload } from "./update-managed-service-handoff-schema.js";

const commandKey = "/install/.openclaw-update-child-12345678-1234-1234-1234-123456789abc-command";
const helper = { pid: 100, startIdentity: "helper-start" };

function payload(bound = false): Extract<ManagedHandoffLeasePayload, { version: 2 }> {
  return {
    version: 2,
    action: { kind: "update" },
    helper,
    executor: bound ? { pid: 101, startIdentity: "command-start" } : { ...helper },
  };
}

describe("historical command custody", () => {
  it.each([false, true])("recognizes a markerless command reservation (bound=%s)", (bound) => {
    const lease = payload(bound);
    expect(managedCommandCustody(lease, commandKey)).toBe(bound ? "bound" : "reserved");
    expect(
      managedCommandCustody({
        ...lease,
        key: commandKey,
        owner: "reservation",
        payload: JSON.stringify(lease),
        updatedAt: 1,
      }),
    ).toBe(bound ? "bound" : "reserved");
  });

  it.each([undefined, "/install", "/install/.openclaw-update-child-unknown-command"])(
    "retains refusal for an unrecognized child key %s",
    (key) => expect(managedCommandCustody(payload(), key)).toBeUndefined(),
  );

  it("does not mistake a mutation receiver for historical command custody", () => {
    const lease = payload();
    lease.action.mutationProtocol = "original-cancellation-v1";
    expect(managedCommandCustody(lease, commandKey)).toBeUndefined();
    delete lease.action.mutationProtocol;
    lease.mutationOriginal = { key: "/install", owner: "original", payload: "original-payload" };
    expect(managedCommandCustody(lease, commandKey)).toBeUndefined();
  });

  it.each(["reserved", "bound"] as const)(
    "preserves explicit %s custody even for a historical non-command key",
    (custody) => {
      const lease = payload();
      lease.action.custody = custody;
      expect(managedCommandCustody(lease, "/install/.openclaw-update-child-unknown")).toBe(custody);
    },
  );
});
