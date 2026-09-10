import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isDiagnosticsEnabled,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "../logging/diagnostic.js";
import type { GatewayEventLoopHealth } from "./server/event-loop-health.js";

/** Keeps diagnostic reconfiguration bound to the live Gateway lifecycle. */
export function createGatewayDiagnosticsController(params: {
  isClosing: () => boolean;
  sampleEventLoopHealth: () => GatewayEventLoopHealth | undefined;
}): (config: OpenClawConfig) => void {
  return (config) => {
    if (params.isClosing()) {
      return;
    }
    const enabled = isDiagnosticsEnabled(config);
    setDiagnosticsEnabledForProcess(enabled);
    if (!enabled) {
      stopDiagnosticHeartbeat();
      return;
    }
    // Gateway lifecycle owns both this existing heartbeat timer and the monitor
    // it samples, so startup failure and normal close tear them down together.
    startDiagnosticHeartbeat(undefined, {
      getConfig: getRuntimeConfig,
      startupGraceMs: 60_000,
      sampleLiveness: () => {
        const sample = params.sampleEventLoopHealth();
        if (!sample || sample.degradedSinceMs == null) {
          return null;
        }
        return {
          reasons: sample.reasons,
          intervalMs: sample.intervalMs,
          degradedSinceMs: sample.degradedSinceMs,
          eventLoopDelayP99Ms: sample.delayP99Ms,
          eventLoopDelayMaxMs: sample.delayMaxMs,
          eventLoopUtilization: sample.utilization,
          cpuCoreRatio: sample.cpuCoreRatio,
        };
      },
    });
  };
}
