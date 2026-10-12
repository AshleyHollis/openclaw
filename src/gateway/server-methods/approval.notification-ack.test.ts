import { afterEach, expect, it, vi, type TestContext } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { createPreparedTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { getOperatorApprovalDetailed } from "../operator-approval-store.js";
import { createApprovalInvocation, createClient, createContext } from "./approval.test-support.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";

afterEach(() => vi.restoreAllMocks());

type ApprovalKind = "exec" | "plugin";

async function createFixture(
  test: TestContext,
  kind: ApprovalKind,
  channelNotice: () => Promise<void>,
  iosNotice: () => Promise<void>,
  webNotice: () => Promise<void>,
) {
  const forwarder: ExecApprovalForwarder = {
    handleRequested: async () => false,
    handleResolved: channelNotice,
    handlePluginApprovalResolved: channelNotice,
    stop: async () => {},
  };
  const context = createContext(undefined, {
    handleRequested: async () => false,
    handleResolved: webNotice,
    handleExpired: async () => {},
  });
  const client = createClient({ deviceId: "notice-reviewer" });
  if (kind === "exec") {
    const fixture = await createPreparedTestApprovalManager(test);
    const record = fixture.manager.create({ command: "echo synthetic notice" }, 60_000);
    record.approvalReviewerDeviceIds = ["notice-reviewer"];
    const { decision } = await fixture.manager.register(record, 60_000);
    const invocation = createApprovalInvocation({
      handlers: createExecApprovalHandlers(fixture.manager, {
        forwarder,
        iosPushDelivery: { handleResolved: iosNotice },
      }),
      method: "exec.approval.resolve",
      body: { id: record.id, decision: "deny" },
      client,
      context,
    });
    return { ...fixture, record, decision, invocation };
  }
  const fixture = await createPreparedTestApprovalManager<PluginApprovalRequestPayload>(test, {
    approvalKind: "plugin",
  });
  const record = fixture.manager.create(
    { title: "Synthetic operation", description: "Confirm the synthetic operation" },
    60_000,
  );
  record.approvalReviewerDeviceIds = ["notice-reviewer"];
  const { decision } = await fixture.manager.register(record, 60_000);
  const invocation = createApprovalInvocation({
    handlers: createPluginApprovalHandlers(fixture.manager, {
      forwarder,
      iosPushDelivery: { handleResolved: iosNotice },
    }),
    method: "plugin.approval.resolve",
    body: { id: record.id, decision: "deny" },
    client,
    context,
  });
  return { ...fixture, record, decision, invocation };
}

const noticeCases = (["exec", "plugin"] as const).flatMap((kind) =>
  (["channel", "ios", "web"] as const).map((notice) => ({ kind, notice })),
);

it.for(noticeCases)(
  "acknowledges a committed $kind verdict while its $notice notice is held",
  async ({ kind, notice }, test) => {
    const entered = createDeferred();
    const release = createDeferred();
    const held = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const channel = notice === "channel" ? held : vi.fn(async () => {});
    const ios = notice === "ios" ? held : vi.fn(async () => {});
    const web = notice === "web" ? held : vi.fn(async () => {});
    const fixture = await createFixture(test, kind, channel, ios, web);
    await fixture.run(async () => {
      const resolution = fixture.track(fixture.invocation.invoke());
      try {
        await withinTest(entered.promise, test.signal);
        await expect(fixture.decision).resolves.toBe("deny");
        expect(
          await getOperatorApprovalDetailed({
            id: fixture.record.id,
            nowMs: Date.now(),
            databaseOptions: fixture.databaseOptions,
          }),
        ).toMatchObject({ outcome: "found", record: { status: "denied", decision: "deny" } });
        expect(fixture.invocation.respond).toHaveBeenCalledExactlyOnceWith(
          true,
          { ok: true },
          undefined,
        );
      } finally {
        release.resolve();
        await resolution;
      }
      expect(channel).toHaveBeenCalledTimes(1);
      expect(ios).toHaveBeenCalledTimes(1);
      expect(web).toHaveBeenCalledTimes(1);
      expect(fixture.invocation.respond).toHaveBeenCalledTimes(1);
    });
  },
);

it.for(["exec", "plugin"] as const)(
  "keeps the %s verdict acknowledged and delivers siblings after notification failures",
  async (kind, test) => {
    const channel = vi.fn(async () => {
      throw new Error("synthetic channel notice failure");
    });
    const ios = vi.fn(async () => {
      throw new Error("synthetic push notice failure");
    });
    const web = vi.fn(async () => {});
    const fixture = await createFixture(test, kind, channel, ios, web);
    await fixture.run(async () => {
      expect(await fixture.invocation.invoke()).toMatchObject({ ok: true, result: { ok: true } });
      await expect(fixture.decision).resolves.toBe("deny");
      expect(web).toHaveBeenCalledTimes(1);
      expect(fixture.invocation.context.logGateway.error).toHaveBeenCalledWith(
        `${kind} approvals: forward resolve failed: Error: synthetic channel notice failure`,
      );
      expect(fixture.invocation.context.logGateway.error).toHaveBeenCalledWith(
        `${kind} approvals: iOS push resolve failed: Error: synthetic push notice failure`,
      );
      expect(fixture.invocation.respond).toHaveBeenCalledTimes(1);
    });
  },
);
