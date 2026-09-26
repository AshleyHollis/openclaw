import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { cronJobReadView } from "../cron/job-read-view.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../cron/normalize.js";
import type { GatewayCronServiceContract } from "../gateway/server-cron-contract.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { PluginHookGatewayCronService } from "./hook-gateway.types.js";

export type PluginServiceCronHost = Pick<
  GatewayCronServiceContract,
  | "list"
  | "add"
  | "update"
  | "remove"
  | "removeStaleJobFamily"
  | "status"
  | "readJob"
  | "updateWithPrecondition"
>;

export function createPluginServiceCronGetter(params: {
  getCron: () => PluginServiceCronHost | null | undefined;
  lease: PluginRuntimeCapabilityLease;
  isStopping: () => boolean;
}): () => PluginHookGatewayCronService | undefined {
  let current: { cron: PluginServiceCronHost; service: PluginHookGatewayCronService } | undefined;
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
    const service: PluginHookGatewayCronService = {
      isEnabled: async () => {
        commitGuard();
        const { enabled } = await cron.status();
        commitGuard();
        return enabled;
      },
      list: async (opts) => {
        commitGuard();
        const jobs = await cron.list(opts);
        commitGuard();
        return jobs;
      },
      getWithRevision: async (id) => {
        commitGuard();
        const job = await cron.readJob(id);
        commitGuard();
        return job ? cronJobReadView(job) : undefined;
      },
      add: async (input) => {
        commitGuard();
        if (input.id !== undefined && input.declarationKey !== undefined) {
          throw new Error("Plugin service cron reserved ID cannot use a declarative upsert key");
        }
        const normalized = normalizeCronJobCreate(input);
        if (!normalized) {
          throw new Error("Plugin service cron create input is invalid");
        }
        return await cron.add(normalized, { commitGuard });
      },
      update: async (id, patch) => {
        commitGuard();
        const normalized = normalizeCronJobPatch(patch);
        if (!normalized) {
          throw new Error("Plugin service cron update input is invalid");
        }
        return await cron.update(id, normalized, { commitGuard });
      },
      updateWithRevision: async (id, patch, expectedConfigRevision) => {
        commitGuard();
        if (!expectedConfigRevision) {
          throw new Error("Plugin service cron update requires a configuration revision");
        }
        const normalized = normalizeCronJobPatch(patch);
        if (!normalized) {
          throw new Error("Plugin service cron update input is invalid");
        }
        const updated = await cron.updateWithPrecondition(
          id,
          normalized,
          (job) => {
            const actualConfigRevision = resolveCronJobConfigRevision(job);
            if (actualConfigRevision !== expectedConfigRevision) {
              throw Object.assign(new Error("Cron job configuration changed"), {
                code: "CRON_JOB_CHANGED",
                actualConfigRevision,
              });
            }
          },
          { commitGuard },
        );
        commitGuard();
        return cronJobReadView(updated);
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
