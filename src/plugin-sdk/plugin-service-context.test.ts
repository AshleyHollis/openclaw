import { describe, expectTypeOf, it } from "vitest";
import type { OpenClawPluginServiceContext as CoreServiceContext } from "./core.js";
import type { DiagnosticEventPayload, DiagnosticEventPrivateData } from "./diagnostic-runtime.js";
import type { OpenClawPluginServiceContext as PluginEntryServiceContext } from "./plugin-entry.js";

type ListenerArgs<T extends { internalDiagnostics?: unknown }> =
  NonNullable<T["internalDiagnostics"]> extends { onEvent: infer TOnEvent }
    ? TOnEvent extends (listener: infer TListener) => unknown
      ? TListener extends (...args: infer TArgs) => unknown
        ? TArgs
        : never
      : never
    : never;

type ListenerPrivateData<T extends { internalDiagnostics?: unknown }> = ListenerArgs<T>[2];
type InternalDiagnostics<T extends { internalDiagnostics?: unknown }> = NonNullable<
  T["internalDiagnostics"]
>;
type TelemetryExporterEvent = Extract<DiagnosticEventPayload, { type: "telemetry.exporter" }>;
type ServiceCron = NonNullable<ReturnType<NonNullable<PluginEntryServiceContext["getCron"]>>>;

describe("plugin service diagnostics contract", () => {
  it("publishes revision-safe service scheduling through both SDK entrypoints", () => {
    expectTypeOf<CoreServiceContext["getCron"]>().toEqualTypeOf<
      PluginEntryServiceContext["getCron"]
    >();
    expectTypeOf<
      Awaited<ReturnType<ServiceCron["add"]>>["configRevision"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      Awaited<ReturnType<ServiceCron["update"]>>["configRevision"]
    >().toEqualTypeOf<string>();
    expectTypeOf<Parameters<ServiceCron["update"]>[2]>().toEqualTypeOf<
      { expectedConfigRevision?: string } | undefined
    >();
    const declaration = {
      declarationKey: "test-plugin:maintenance",
      name: "Plugin maintenance",
      enabled: false,
      schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC", staggerMs: 0 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "Run plugin maintenance.",
        toolsAllow: ["test_maintenance"],
      },
      delivery: { mode: "none" as const },
    } satisfies Parameters<ServiceCron["add"]>[0];
    expectTypeOf(declaration).toExtend<Parameters<ServiceCron["add"]>[0]>();
  });

  it("keeps host attribution out of public SDK listener declarations", () => {
    expectTypeOf<
      ListenerPrivateData<PluginEntryServiceContext>
    >().toEqualTypeOf<DiagnosticEventPrivateData>();
    expectTypeOf<
      ListenerPrivateData<CoreServiceContext>
    >().toEqualTypeOf<DiagnosticEventPrivateData>();
    expectTypeOf<ListenerArgs<PluginEntryServiceContext>["length"]>().toEqualTypeOf<3>();
    expectTypeOf<ListenerArgs<CoreServiceContext>["length"]>().toEqualTypeOf<3>();
    expectTypeOf<
      "hostPluginId" extends keyof ListenerPrivateData<PluginEntryServiceContext> ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "reportExporterHealth" extends keyof InternalDiagnostics<PluginEntryServiceContext>
        ? true
        : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "reportExporterHealth" extends keyof InternalDiagnostics<CoreServiceContext> ? true : false
    >().toEqualTypeOf<false>();
  });

  it("keeps the shipped telemetry exporter event union unchanged", () => {
    expectTypeOf<TelemetryExporterEvent["status"]>().toEqualTypeOf<
      "started" | "failure" | "dropped"
    >();
    expectTypeOf<NonNullable<TelemetryExporterEvent["reason"]>>().toEqualTypeOf<
      | "configured"
      | "emit_failed"
      | "handler_failed"
      | "queue_full"
      | "shutdown_failed"
      | "start_failed"
      | "unsupported_protocol"
    >();
    expectTypeOf<
      "transport" extends keyof TelemetryExporterEvent ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "endpointMode" extends keyof TelemetryExporterEvent ? true : false
    >().toEqualTypeOf<false>();
  });
});
