import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../cron/normalize.js";
import type { CronJob } from "../cron/types.js";
import type { GatewayCronServiceContract } from "../gateway/server-cron-contract.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { PluginHookGatewayCronService, PluginServiceCronScheduler } from "./hook-types.js";

export type PluginServiceCronHost = Pick<
  GatewayCronServiceContract,
  keyof PluginHookGatewayCronService | "updateWithPrecondition"
>;

function revisionedJob(job: CronJob) {
  const snapshot = structuredClone(job);
  return { ...snapshot, configRevision: resolveCronJobConfigRevision(snapshot) };
}

export function createPluginServiceCronGetter(params: {
  getCron: () => PluginServiceCronHost | null | undefined;
  lease: PluginRuntimeCapabilityLease;
  isStopping: () => boolean;
}): () => PluginServiceCronScheduler | undefined {
  let current: { cron: PluginServiceCronHost; service: PluginServiceCronScheduler } | undefined;
  const assertServiceActive = () => {
    params.lease.assertActive("cron scheduler");
    if (params.isStopping()) {
      throw new Error("Plugin service cron scheduler is stopping");
    }
  };
  return () => {
    assertServiceActive();
    const cron = params.getCron();
    if (!cron) {
      return undefined;
    }
    if (current?.cron === cron) {
      return current.service;
    }
    const commitGuard = () => {
      assertServiceActive();
      if (params.getCron() !== cron) {
        throw new Error("Plugin service cron scheduler was replaced");
      }
    };
    // A retained handle owns one scheduler. Recheck at the store lock, not only
    // before awaiting it, so replacement cannot admit an old queued write.
    const service: PluginServiceCronScheduler = {
      list: async (opts) => {
        commitGuard();
        const jobs = await cron.list(opts);
        commitGuard();
        return jobs.map(revisionedJob);
      },
      add: async (input) => {
        commitGuard();
        const normalized = normalizeCronJobCreate(input);
        if (!normalized) {
          throw new Error("Plugin service cron create input is invalid");
        }
        const added = await cron.add(normalized, { commitGuard });
        return revisionedJob("job" in added ? added.job : added);
      },
      update: async (id, patch, opts) => {
        commitGuard();
        const expected = opts?.expectedConfigRevision;
        if (expected !== undefined && (typeof expected !== "string" || !expected.trim())) {
          throw new Error("Plugin service cron configuration revision is invalid");
        }
        const normalized = normalizeCronJobPatch(patch);
        if (!normalized) {
          throw new Error("Plugin service cron update input is invalid");
        }
        const updated = await cron.updateWithPrecondition(
          id,
          normalized,
          (job) => {
            commitGuard();
            if (expected !== undefined && resolveCronJobConfigRevision(job) !== expected) {
              throw new Error("cron job definition no longer matches the loaded version");
            }
          },
          { commitGuard },
        );
        return revisionedJob(updated);
      },
      remove: async (id) => {
        commitGuard();
        return await cron.remove(id, { commitGuard });
      },
      removeStaleJobFamily: async (family) => {
        commitGuard();
        return await cron.removeStaleJobFamily(family, { commitGuard });
      },
    };
    current = { cron, service };
    return service;
  };
}
