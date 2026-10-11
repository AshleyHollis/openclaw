import type { PreparedConfigRuntimeEnv } from "./config-env-vars.js";
import type { ConfigSnapshotPreparation } from "./io.snapshot-preparation.types.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

export type RuntimeConfigSnapshotRefreshOptions = {
  includeAuthStoreRefs?: boolean;
  requireImmediateApplication?: boolean;
};

export type RuntimeConfigSnapshotRefreshParams = RuntimeConfigSnapshotRefreshOptions & {
  sourceConfig: OpenClawConfig;
  preflightResult?: unknown;
  /** Original write authority; refresh owners recheck immediately before activation. */
  assertCurrent?: () => void;
};
type MaybePromise<T> = T | Promise<T>;

export type RuntimeConfigSnapshotPreparationContext = { env?: NodeJS.ProcessEnv };

export type ConfigWriteAfterWrite =
  | { mode: "auto" }
  | { mode: "restart"; reason: string }
  | { mode: "none"; reason: string };

export type ConfigWriteFollowUp =
  | (Exclude<ConfigWriteAfterWrite, { mode: "restart" }> & { requiresRestart: false })
  | (Extract<ConfigWriteAfterWrite, { mode: "restart" }> & { requiresRestart: true });

export type RuntimeConfigSnapshotRefreshHandler = {
  preflight?: (params: RuntimeConfigSnapshotRefreshParams) => MaybePromise<unknown>;
  refresh: (params: RuntimeConfigSnapshotRefreshParams) => boolean | Promise<boolean>;
  clearOnRefreshFailure?: () => void;
};

export type RuntimeConfigWriteNotification = {
  configPath: string;
  snapshot: ConfigFileSnapshot;
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
  persistedHash: string;
  revision: number;
  fingerprint: string;
  sourceFingerprint: string | null;
  writtenAtMs: number;
  afterWrite?: ConfigWriteAfterWrite;
  runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions;
  preparedCandidate?: RuntimeConfigWritePreparedCandidate;
  preparedCandidatesByOwner?: ReadonlyMap<symbol, RuntimeConfigWritePreparedCandidate>;
};

export type RuntimeConfigWritePreparedCandidate = {
  runtimeConfig: OpenClawConfig;
  compareConfig: OpenClawConfig;
  runtimeEnv?: PreparedConfigRuntimeEnv;
  reapplyRuntimeOverlays?: (config: OpenClawConfig) => OpenClawConfig;
  reapplyCompareOverlays?: (config: OpenClawConfig) => OpenClawConfig;
};

export type RuntimeConfigSnapshotMetadata = {
  revision: number;
  fingerprint: string;
  sourceFingerprint: string | null;
  updatedAtMs: number;
};

export type ManagedRuntimeConfigWritePreflight = (
  sourceConfig: OpenClawConfig,
  refreshOptions?: RuntimeConfigSnapshotRefreshOptions,
) => MaybePromise<RuntimeConfigWritePreparedCandidate>;
export type ManagedRuntimeConfigWriteOwner = {
  id: symbol;
  preflight?: ManagedRuntimeConfigWritePreflight;
  prepareSnapshot?: ConfigSnapshotPreparation;
};
export type RuntimeConfigSnapshotAsyncPreparer = {
  prepareAsync: (
    config: OpenClawConfig,
    context: RuntimeConfigSnapshotPreparationContext,
  ) => Promise<() => void>;
};
export type RuntimeConfigAsyncLoader = (assertCurrent: () => void) => Promise<{
  config: OpenClawConfig;
  runtimeEnv?: PreparedConfigRuntimeEnv;
}>;
