import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import {
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
} from "../agents/workspace-legacy-state.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
} from "../agents/workspace-state-store.js";
import { moveToTrash } from "../commands/onboard-helpers.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import { listConfiguredMcpServers, unsetConfiguredMcpServer } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deleteAgentConfigEntry } from "../gateway/server-methods/agents-config-mutations.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { deleteClawCronRef, markClawCronRefRemoved, type ClawCronGateway } from "./cron.js";
import {
  clawRemoveQuietRuntime,
  deletionEffects,
  releaseClawRemoveRows,
  removeClawWorkspaceFile,
  type RemovedWorkspaceFile,
} from "./lifecycle-delete-support.js";
import {
  buildClawRemovePlan,
  CLAW_REMOVE_RESULT_SCHEMA_VERSION,
  ClawRemoveError,
  digestAgent,
  readClawStatus,
  type ClawRemovePlan,
} from "./lifecycle-state-core.js";
import { deleteClawMcpServerRef, planClawMcpServerRemoval } from "./mcp.js";
import {
  applyClawPackageRemovals,
  planClawPackageRemovals,
  type ClawPackageRemovalResult,
  type PackageRemovalDeps,
} from "./package-remove.js";
import { updateClawInstallRecordStatus } from "./provenance.js";
import { CLAW_OUTPUT_STABILITY } from "./types.js";

type RemovedCronJob = {
  manifestId: string;
  schedulerJobId?: string;
  action: "removed" | "error";
  message?: string;
};
type RemovedMcpServer = {
  name: string;
  action: "removed" | "missing" | "released" | "error";
  message?: string;
};
type ClawRemoveResult = {
  schemaVersion: typeof CLAW_REMOVE_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  status: "complete" | "partial";
  agentId: string;
  agentRemoved: boolean;
  workspaceFiles: RemovedWorkspaceFile[];
  packages: ClawPackageRemovalResult[];
  mcpServers: RemovedMcpServer[];
  cronJobs: RemovedCronJob[];
  packageRefsReleased: number;
  error?: { code: string; message: string };
};

type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;
export async function applyClawRemovePlan(
  plan: ClawRemovePlan,
  options: OpenClawStateDatabaseOptions & {
    config?: OpenClawConfig;
    sourceMcpServers?: Record<string, Record<string, unknown>>;
    listMcpServers?: typeof listConfiguredMcpServers;
    commitConfig?: ConfigCommit;
    deleteAgent?: (agentId: string) => Promise<void>;
    packageDeps?: PackageRemovalDeps;
    consentPlanIntegrity?: string;
    unsetMcpServer?: typeof unsetConfiguredMcpServer;
    cronGateway?: Pick<ClawCronGateway, "remove">;
  } = {},
): Promise<ClawRemoveResult> {
  if (options.consentPlanIntegrity !== plan.planIntegrity) {
    throw new ClawRemoveError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw remove plan; run remove --dry-run again.",
    );
  }
  if (plan.blockers.length > 0 || !plan.agentId) {
    throw new ClawRemoveError("remove_blocked", "The Claw remove plan contains blockers.");
  }
  const currentPlan = await buildClawRemovePlan(plan.target, options);
  if (currentPlan.planIntegrity !== plan.planIntegrity) {
    throw new ClawRemoveError("remove_changed", "Claw-owned state changed after remove planning.");
  }
  const agentId = plan.agentId;
  const current = await readClawStatus(plan.agentId, options);
  const record = current.records[0];
  if (
    !record ||
    record.agentState === "modified" ||
    record.workspaceFiles.some((file) => file.state === "unsafe") ||
    record.mcpServers.some((server) => server.state === "pending")
  ) {
    throw new ClawRemoveError("remove_changed", "Claw-owned state changed after remove planning.");
  }
  const packageDecisions = await planClawPackageRemovals(record.install, record.packages, {
    ...options,
    deps: options.packageDeps,
  });
  const plannedPackages = plan.actions
    .filter((action) => action.kind === "packageRef")
    .map((action) => `${action.id}:${action.action}`)
    .toSorted();
  const currentPackages = packageDecisions
    .map(
      (decision) =>
        `${decision.packageRef.kind}:${decision.packageRef.ref}@${decision.packageRef.version}:${decision.action === "uninstall" ? "uninstall" : "release"}`,
    )
    .toSorted();
  if (JSON.stringify(plannedPackages) !== JSON.stringify(currentPackages)) {
    throw new ClawRemoveError("remove_changed", "Package ownership changed after remove planning.");
  }
  const plannedMcpServers = plan.actions
    .filter((action) => action.kind === "mcpServer")
    .map((action) => `${action.id}:${action.action}`)
    .toSorted();
  const currentMcpServers = record.mcpServers
    .map((server) => {
      const action =
        server.state === "present" ? planClawMcpServerRemoval(server, options) : "release";
      return `${server.name}:${action}`;
    })
    .toSorted();
  if (JSON.stringify(plannedMcpServers) !== JSON.stringify(currentMcpServers)) {
    throw new ClawRemoveError("remove_changed", "MCP ownership changed after remove planning.");
  }
  const mcpServers: RemovedMcpServer[] = [];
  const listedMcpServers = options.sourceMcpServers
    ? undefined
    : options.listMcpServers
      ? await options.listMcpServers()
      : options.config
        ? undefined
        : await listConfiguredMcpServers();
  if (listedMcpServers && !listedMcpServers.ok) {
    throw new ClawRemoveError("mcp_config_unavailable", listedMcpServers.error);
  }
  const configuredMcpServers = listedMcpServers?.ok
    ? listedMcpServers.mcpServers
    : normalizeConfiguredMcpServers(options.sourceMcpServers ?? options.config?.mcp?.servers);
  const unsetMcpServer = options.unsetMcpServer ?? unsetConfiguredMcpServer;
  for (const server of record.mcpServers) {
    const ownerAction =
      server.state === "present" ? planClawMcpServerRemoval(server, options) : "release";
    if (server.state !== "present" || ownerAction === "release") {
      deleteClawMcpServerRef(plan.agentId, server.name, options);
      mcpServers.push({
        name: server.name,
        action: server.state === "missing" ? "missing" : "released",
      });
      continue;
    }
    const expectedServer = configuredMcpServers[server.name];
    if (!expectedServer) {
      throw new ClawRemoveError(
        "mcp_cleanup_changed",
        `MCP server ${JSON.stringify(server.name)} disappeared during removal.`,
      );
    }
    try {
      const result = await unsetMcpServer({ name: server.name, expectedServer });
      if (!result.ok) {
        throw new Error(result.error);
      }
      deleteClawMcpServerRef(plan.agentId, server.name, options);
      mcpServers.push({ name: server.name, action: result.removed ? "removed" : "missing" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mcpServers.push({ name: server.name, action: "error", message });
      updateClawInstallRecordStatus(agentId, "partial", options);
      return {
        schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        dryRun: false,
        status: "partial",
        agentId,
        agentRemoved: false,
        workspaceFiles: [],
        packages: [],
        mcpServers,
        cronJobs: [],
        packageRefsReleased: 0,
        error: { code: "mcp_cleanup_failed", message },
      };
    }
  }
  const cronJobs: RemovedCronJob[] = [];
  for (const cron of record.cronJobs) {
    if (cron.status !== "removed" && (!cron.schedulerJobId || cron.status !== "complete")) {
      throw new ClawRemoveError(
        "cron_cleanup_uncertain",
        `Cron declaration ${JSON.stringify(cron.manifestId)} is not safely removable.`,
      );
    }
    if (cron.status !== "removed" && !options.cronGateway) {
      throw new ClawRemoveError(
        "cron_gateway_required",
        "Claw cron jobs require the gateway-owned cron.remove API.",
      );
    }
    try {
      if (cron.status !== "removed") {
        await options.cronGateway!.remove(cron.schedulerJobId!);
        markClawCronRefRemoved(plan.agentId, cron.manifestId, options);
      }
      deleteClawCronRef(plan.agentId, cron.manifestId, options);
      cronJobs.push({
        manifestId: cron.manifestId,
        schedulerJobId: cron.schedulerJobId,
        action: "removed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cronJobs.push({
        manifestId: cron.manifestId,
        schedulerJobId: cron.schedulerJobId,
        action: "error",
        message,
      });
      updateClawInstallRecordStatus(agentId, "partial", options);
      return {
        schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        dryRun: false,
        status: "partial",
        agentId: plan.agentId,
        agentRemoved: false,
        workspaceFiles: [],
        packages: [],
        mcpServers,
        cronJobs,
        packageRefsReleased: 0,
        error: { code: "cron_cleanup_failed", message },
      };
    }
  }
  let agentRemoved = false;
  const packages = await applyClawPackageRemovals(packageDecisions, {
    ...options,
    deps: options.packageDeps,
  });
  const packageErrors = packages.filter((pkg) => pkg.action === "error");
  if (packageErrors.length > 0) {
    updateClawInstallRecordStatus(agentId, "partial", options);
    return {
      schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      status: "partial",
      agentId: plan.agentId,
      agentRemoved,
      workspaceFiles: [],
      packages,
      mcpServers,
      cronJobs,
      packageRefsReleased: 0,
      error: {
        code: "package_cleanup_failed",
        message: packageErrors.map((pkg) => pkg.reason).join("; "),
      },
    };
  }
  let committedDelete: Awaited<ReturnType<typeof deleteAgentConfigEntry>>["result"] | undefined;
  let committedNextConfig: OpenClawConfig | undefined;
  if (record.agentState === "present" && options.deleteAgent) {
    try {
      await options.deleteAgent(agentId);
      agentRemoved = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateClawInstallRecordStatus(agentId, "partial", options);
      return {
        schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        dryRun: false,
        status: "partial",
        agentId,
        agentRemoved: false,
        workspaceFiles: [],
        packages,
        mcpServers,
        cronJobs,
        packageRefsReleased: 0,
        error: { code: "agent_cleanup_failed", message },
      };
    }
  } else if (options.commitConfig) {
    await options.commitConfig((config) => {
      const deleteEffects = deletionEffects(config, agentId);
      const agents = config.agents?.list ?? [];
      const agent = agents.find((candidate) => candidate.id === plan.agentId);
      if (agent && digestAgent(agent) !== record.install.agentConfigDigest) {
        throw new ClawRemoveError("agent_modified", "Agent config changed during remove.");
      }
      agentRemoved = Boolean(agent);
      return deleteEffects.pruned.config;
    });
  } else {
    const committed = await deleteAgentConfigEntry({
      agentId,
      validate: (agent) => {
        if (digestAgent(agent) !== record.install.agentConfigDigest) {
          throw new ClawRemoveError("agent_modified", "Agent config changed during remove.");
        }
      },
    });
    agentRemoved = Boolean(committed.result);
    committedDelete = committed.result;
    committedNextConfig = committed.nextConfig;
  }
  const workspaceFiles: RemovedWorkspaceFile[] = [];
  for (const file of record.workspaceFiles) {
    workspaceFiles.push(await removeClawWorkspaceFile(file));
  }
  const errors = workspaceFiles.filter((file) => file.action === "error");
  const complete = errors.length === 0;
  if (complete && committedDelete && committedNextConfig) {
    const workspaceSharedWith = findOverlappingWorkspaceAgentIds(
      committedNextConfig,
      agentId,
      committedDelete.workspaceDir,
    );
    if (workspaceSharedWith.length === 0) {
      const legacyPlan = prepareLegacyWorkspaceStateReset(committedDelete.workspaceDir);
      const statePlan = prepareWorkspaceStateDeletion(committedDelete.workspaceDir);
      const workspaceRemoved = await moveToTrash(
        committedDelete.workspaceDir,
        clawRemoveQuietRuntime,
      );
      if (workspaceRemoved) {
        const legacyCleanup = await removeLegacyWorkspaceStateForReset(legacyPlan);
        for (const warning of legacyCleanup.warnings) {
          clawRemoveQuietRuntime.log(warning);
        }
        deleteWorkspaceState(statePlan);
      }
    }
    await moveToTrash(committedDelete.agentDir, clawRemoveQuietRuntime);
    await moveToTrash(committedDelete.sessionsDir, clawRemoveQuietRuntime);
  }
  releaseClawRemoveRows(plan.agentId, workspaceFiles, complete, options);
  return {
    schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    status: complete ? "complete" : "partial",
    agentId: plan.agentId,
    agentRemoved,
    workspaceFiles,
    packages,
    mcpServers,
    cronJobs,
    packageRefsReleased: complete ? record.packages.length : 0,
    ...(complete
      ? {}
      : {
          error: {
            code: "workspace_cleanup_failed",
            message: errors.map((error) => error.message).join("; "),
          },
        }),
  };
}
