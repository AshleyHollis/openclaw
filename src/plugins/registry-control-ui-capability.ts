import { normalizePluginHostHookId, type PluginControlUiDescriptor } from "./host-hooks.js";

export function normalizeHostHookString(value: unknown): string {
  return typeof value === "string" ? normalizePluginHostHookId(value) : "";
}

export function normalizeOptionalHostHookString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

const controlUiSurfaces = new Set<PluginControlUiDescriptor["surface"]>([
  "session",
  "tool",
  "run",
  "settings",
  "tab",
  "widget",
]);

export function isControlUiSurface(value: string): value is PluginControlUiDescriptor["surface"] {
  // SAFETY: Set membership is the runtime proof that value is a declared surface literal.
  return controlUiSurfaces.has(value as PluginControlUiDescriptor["surface"]);
}

type CapabilityBridgeNormalization =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; value: PluginControlUiDescriptor["capabilityBridge"] };

export function normalizeCapabilityBridge(
  value: unknown,
  normalizeStringList: (value: unknown) => string[] | undefined | null,
): CapabilityBridgeNormalization {
  if (value === undefined) {
    return { kind: "absent" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid" };
  }
  // SAFETY: bridge fields remain unknown and are validated individually below.
  const bridge = value as {
    protocolVersion?: unknown;
    requiredMethods?: unknown;
    optionalMethods?: unknown;
    sessionNavigationResolver?: unknown;
  };
  if (
    bridge.protocolVersion !== 1 ||
    !Array.isArray(bridge.requiredMethods) ||
    !Array.isArray(bridge.optionalMethods)
  ) {
    return { kind: "invalid" };
  }
  const requiredMethods = normalizeStringList(bridge.requiredMethods);
  const optionalMethods = normalizeStringList(bridge.optionalMethods);
  if (
    requiredMethods === null ||
    optionalMethods === null ||
    !requiredMethods ||
    !optionalMethods
  ) {
    return { kind: "invalid" };
  }
  const methods = [...requiredMethods, ...optionalMethods];
  const resolver = bridge.sessionNavigationResolver;
  if (resolver !== undefined && (typeof resolver !== "string" || !methods.includes(resolver))) {
    return { kind: "invalid" };
  }
  return methods.length <= 32 && new Set(methods).size === methods.length
    ? {
        kind: "valid",
        value: {
          protocolVersion: 1,
          requiredMethods,
          optionalMethods,
          ...(resolver !== undefined ? { sessionNavigationResolver: resolver } : {}),
        },
      }
    : { kind: "invalid" };
}
