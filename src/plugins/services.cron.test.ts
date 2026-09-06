import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronService } from "../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../cron/service.test-harness.js";
import { loadCronStore } from "../cron/store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { startPluginServices, type PluginServicesHandle } from "./services.js";
import type { OpenClawPluginServiceContext } from "./types.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "plugin-service-cron-" });
const handles = new Set<PluginServicesHandle>();
const schedulers = new Set<CronService>();
const family = {
  declarationKey: "test-plugin:maintenance",
  name: "Plugin maintenance",
  ownerPluginTag: "[managed-by=test-plugin]",
};

afterEach(async () => {
  await Promise.all([...handles].map((handle) => handle.stop()));
  handles.clear();
  for (const cron of schedulers) {
    cron.stop();
  }
  schedulers.clear();
});

async function createScheduler() {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    storePath,
    cronEnabled: false,
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  schedulers.add(cron);
  return { cron, storePath };
}

async function startService(getCronService?: () => CronService) {
  const registry = createEmptyPluginRegistry();
  let context: OpenClawPluginServiceContext | undefined;
  registry.services.push({
    pluginId: "test-plugin",
    origin: "workspace",
    source: "test",
    service: {
      id: "maintenance",
      start: (ctx) => {
        context = ctx;
      },
    },
  });
  const handle = await startPluginServices({ registry, config: {}, getCronService });
  handles.add(handle);
  if (!context) {
    throw new Error("Service did not start");
  }
  return { context, handle };
}

function createJob(name = family.name) {
  return {
    declarationKey: family.declarationKey,
    name,
    description: family.ownerPluginTag,
    enabled: false,
    schedule: { kind: "cron" as const, expr: "0 2 * * *" },
    sessionTarget: "main" as const,
    wakeMode: "now" as const,
    payload: { kind: "systemEvent" as const, text: "maintenance" },
  };
}

describe("plugin service scheduler ownership", () => {
  it("leaves scheduler access absent outside the Gateway owner", async () => {
    const { context } = await startService();
    expect(context.getCron).toBeUndefined();
  });

  it("keeps one handle per scheduler and reconciles through a successor service", async () => {
    const { cron } = await createScheduler();
    const first = await startService(() => cron);
    const service = first.context.getCron?.();
    if (!service) {
      throw new Error("Gateway service has no scheduler");
    }
    expect(first.context.getCron?.()).toBe(service);
    await service.add(createJob());
    await first.handle.stop();
    expect(() => first.context.getCron?.()).toThrow("no longer active");
    await expect(service.list()).rejects.toThrow("no longer active");

    const next = await startService(() => cron);
    const successor = next.context.getCron?.();
    if (!successor) {
      throw new Error("Replacement service has no scheduler");
    }
    const job = expectDefined(
      (await successor.list({ includeDisabled: true }))[0],
      "managed plugin job",
    );
    expect(job).toMatchObject({ declarationKey: family.declarationKey });
    await successor.update(job.id, { schedule: { kind: "cron", expr: "0 3 * * *" } });
    expect(await successor.list({ includeDisabled: true })).toMatchObject([
      { id: job.id, schedule: { expr: "0 3 * * *" } },
    ]);
  });

  it("rejects a stale configuration after waiting for a newer scheduler write", async () => {
    const { cron } = await createScheduler();
    const { context } = await startService(() => cron);
    const service = expectDefined(context.getCron?.(), "service scheduler");
    await service.add(createJob());
    const loaded = expectDefined((await service.list({ includeDisabled: true }))[0], "loaded job");
    expect(loaded.configRevision).toEqual(expect.any(String));
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const newer = cron.updateWithPrecondition(loaded.id, { name: "Newer schedule" }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const stale = service.update(
      loaded.id,
      { name: "Stale schedule" },
      {
        expectedConfigRevision: loaded.configRevision,
      },
    );
    const rejected = expect(stale).rejects.toThrow("no longer matches the loaded version");
    release.resolve();
    await newer;
    await rejected;
    const current = expectDefined(
      (await service.list({ includeDisabled: true }))[0],
      "current job",
    );
    expect(current.name).toBe("Newer schedule");
    expect(current.configRevision).not.toBe(loaded.configRevision);
    await service.update(
      current.id,
      { name: "Confirmed schedule" },
      {
        expectedConfigRevision: current.configRevision,
      },
    );
    expect(await service.list({ includeDisabled: true })).toMatchObject([
      { name: "Confirmed schedule" },
    ]);
  });

  it("preserves an isolated agent turn's tool cap and returns detached revisioned snapshots", async () => {
    const { cron } = await createScheduler();
    const { context } = await startService(() => cron);
    const service = expectDefined(context.getCron?.(), "service scheduler");
    const added = await service.add({
      ...createJob(),
      sessionTarget: "isolated",
      schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC", staggerMs: 0 },
      payload: {
        kind: "agentTurn",
        message: "Run plugin maintenance.",
        toolsAllow: ["test_maintenance"],
      },
      delivery: { mode: "none" },
    });
    const loaded = expectDefined((await service.list({ includeDisabled: true }))[0], "loaded job");
    expect(added).toMatchObject({ configRevision: loaded.configRevision });
    expect(loaded).toMatchObject({
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", toolsAllow: ["test_maintenance"] },
      delivery: { mode: "none" },
    });
    expectDefined(loaded.payload?.toolsAllow, "tool cap").push("*");
    const current = expectDefined(
      (await service.list({ includeDisabled: true }))[0],
      "current job",
    );
    expect(current.payload?.toolsAllow).toEqual(["test_maintenance"]);
    expect(current.configRevision).toBe(loaded.configRevision);
  });

  it.each(["service stop", "service reload", "scheduler replacement"] as const)(
    "rejects reads and writes queued before %s without changing stored rows",
    async (retirement) => {
      const original = await createScheduler();
      const stale = await createScheduler();
      const replacement = await createScheduler();
      const job = await original.cron.add(createJob());
      await stale.cron.add(createJob());
      let current = original.cron;
      const { context, handle } = await startService(() => current);
      const service = context.getCron?.();
      if (!service) {
        throw new Error("Gateway service has no scheduler");
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const blocker = original.cron.updateWithPrecondition(job.id, {}, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const queued = [
        service.list({ includeDisabled: true }),
        service.add({ ...createJob("late addition"), declarationKey: "test-plugin:late" }),
        service.update(job.id, { name: "late update" }),
        service.remove(job.id),
        service.removeStaleJobFamily(family),
      ];
      const results = Promise.allSettled(queued);
      try {
        if (retirement === "service stop") {
          await handle.stop();
        } else if (retirement === "service reload") {
          await handle.reload({}, new Set(["maintenance"]));
        } else {
          current = replacement.cron;
          expect(context.getCron?.()).not.toBe(service);
        }
      } finally {
        release.resolve();
      }
      await blocker;
      expect((await results).map((result) => result.status)).toEqual([
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
      ]);
      expect((await loadCronStore(original.storePath)).jobs).toMatchObject([
        { id: job.id, name: family.name },
      ]);
      expect((await loadCronStore(stale.storePath)).jobs).toHaveLength(1);
      expect((await loadCronStore(replacement.storePath)).jobs).toHaveLength(0);
    },
  );
});
