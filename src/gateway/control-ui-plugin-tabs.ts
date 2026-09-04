// Projects plugin "tab" Control UI descriptors into the hello payload so the
// dashboard renders plugin tabs without hardcoding plugin ids in core.
// Descriptors come from the process-root registry installed by the gateway.
import type { PluginControlUiDescriptor } from "../plugins/host-hooks.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { getActivePluginSessionExtensionRegistry } from "../plugins/runtime.js";
import { resolveControlUiPluginTabPathname } from "./control-ui-contract.js";
import {
  authorizeOperatorScopesForRequiredScope,
  READ_SCOPE,
  type OperatorScope,
} from "./method-scopes.js";
import { resolvePluginRoutePathContext } from "./server/plugins-http/path-context.js";
import { findMatchingPluginHttpRoutes } from "./server/plugins-http/route-match.js";

type ControlUiPluginTab = {
  pluginId: string;
  id: string;
  label: string;
  description?: string;
  icon?: string;
  path?: string;
  placement?: string;
  group?: "control" | "agent";
  order?: number;
  requiresGatewayAuth?: boolean;
  capabilityBridge?: ControlUiCapabilityBridgeGrant;
};

const CONTROL_UI_CAPABILITY_BRIDGE_LIMITS = {
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 1024 * 1024,
  maxConcurrentRequests: 8,
  maxRequestsPerMinute: 60,
  maxMutationsPerMinute: 12,
  handshakeTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
} as const;

const CONTROL_UI_CAPABILITY_BRIDGE_MAX_LINKED_SESSION_KEYS = 200;

type ControlUiCapabilityBridgeGrant = {
  protocolVersion: 1;
  mode: "read-only" | "read-write";
  methods: string[];
  readMethods: string[];
  missingRequiredMethods: string[];
  upgradeRequired: boolean;
  /** Authenticated plugin/tab links; never rendered into the iframe document. */
  linkedSessionKeys: string[];
  limits: typeof CONTROL_UI_CAPABILITY_BRIDGE_LIMITS;
};

const CORE_BRIDGE_METHODS = new Map<string, "read" | "write" | "local">([
  ["sessions.create", "write"],
  ["chat.history", "read"],
  ["sessions.search", "read"],
  ["chat.send", "write"],
  ["ui.session.navigate", "local"],
]);

type ControlUiPluginWidgetKind = {
  pluginId: string;
  kind: string;
  label: string;
};

// `session` is a core-reserved widget-kind namespace. Core owns progress cards,
// so their availability is scope-gated rather than plugin-gated.
const CORE_CONTROL_UI_WIDGET_KINDS: readonly ControlUiPluginWidgetKind[] = [
  { pluginId: "session", kind: "session:progress", label: "Session progress" },
];

function findControlUiTabGatewayRoute(
  registry: PluginRegistry,
  tab: ControlUiPluginTab,
): ReturnType<typeof findMatchingPluginHttpRoutes>[number] | null | undefined {
  if (!tab.path) {
    return undefined;
  }
  const routePath = resolveControlUiPluginTabPathname(tab.path);
  if (!routePath) {
    return undefined;
  }
  const route = findMatchingPluginHttpRoutes(
    registry,
    resolvePluginRoutePathContext(routePath),
  ).find((candidate) => candidate.auth === "gateway");
  if (!route) {
    return undefined;
  }
  return route.pluginId === tab.pluginId ? route : null;
}

type ControlUiDescriptorEntry = {
  pluginId: string;
  descriptor: PluginControlUiDescriptor;
};

type PluginOwnedSessionEntry = {
  initializationPending?: unknown;
  pluginOwnerId?: unknown;
};

/**
 * Projects the durable plugin ownership fact into a bounded tab input. The
 * caller supplies only the host's session-store snapshot; iframe input never
 * reaches this function or expands a port's initial authority.
 */
export function listControlUiCapabilityBridgeLinkedSessionKeys(
  entries: Iterable<readonly [string, PluginOwnedSessionEntry]>,
): ReadonlyMap<string, readonly string[]> {
  const linksByPlugin = new Map<string, string[]>();
  for (const [sessionKey, entry] of [...entries].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const pluginId = typeof entry.pluginOwnerId === "string" ? entry.pluginOwnerId.trim() : "";
    if (!pluginId || entry.initializationPending === true || !sessionKey) {
      continue;
    }
    const links = linksByPlugin.get(pluginId) ?? [];
    if (links.length >= CONTROL_UI_CAPABILITY_BRIDGE_MAX_LINKED_SESSION_KEYS) {
      continue;
    }
    links.push(sessionKey);
    linksByPlugin.set(pluginId, links);
  }
  return linksByPlugin;
}

export type ControlUiPluginTabAuthGrant = {
  pluginId: string;
  path: string;
  match: "exact" | "prefix";
  scopes: OperatorScope[];
  profileId?: string;
};

/** Pure projection of tab descriptors visible to the presented scopes. */
function projectControlUiPluginTabs(
  entries: readonly ControlUiDescriptorEntry[],
  scopes: readonly string[],
  availableMethods: readonly string[],
  linkedSessionKeysByPlugin: ReadonlyMap<string, readonly string[]>,
): ControlUiPluginTab[] {
  const tabs: ControlUiPluginTab[] = [];
  for (const entry of entries) {
    const descriptor = entry.descriptor;
    if (descriptor.surface !== "tab") {
      continue;
    }
    const visible = (descriptor.requiredScopes ?? []).every(
      (scope) => authorizeOperatorScopesForRequiredScope(scope, scopes).allowed,
    );
    if (!visible) {
      continue;
    }
    const capabilityBridge = projectCapabilityBridge(
      entry.pluginId,
      descriptor,
      scopes,
      availableMethods,
      linkedSessionKeysByPlugin.get(entry.pluginId) ?? [],
    );
    tabs.push({
      pluginId: entry.pluginId,
      id: descriptor.id,
      label: descriptor.label,
      description: descriptor.description,
      icon: descriptor.icon,
      path: descriptor.path,
      placement: descriptor.placement,
      group: descriptor.group,
      order: descriptor.order,
      ...(capabilityBridge ? { capabilityBridge } : {}),
    });
  }
  // Deterministic ordering keeps hello payloads stable across connects.
  return tabs.toSorted(
    (left, right) =>
      (left.order ?? 0) - (right.order ?? 0) ||
      left.label.localeCompare(right.label) ||
      left.id.localeCompare(right.id),
  );
}

/** Lists active plugins' tab descriptors visible to the presented scopes. */
export function listControlUiPluginTabs(
  scopes: readonly string[],
  opts: {
    requireGatewayAuthGrant?: boolean;
    availableMethods?: readonly string[];
    linkedSessionKeysByPlugin?: ReadonlyMap<string, readonly string[]>;
  } = {},
): ControlUiPluginTab[] {
  const registry = getActivePluginSessionExtensionRegistry();
  return projectControlUiPluginTabs(
    registry?.controlUiDescriptors ?? [],
    scopes,
    opts.availableMethods ?? [],
    opts.linkedSessionKeysByPlugin ?? new Map(),
  ).flatMap((tab) => {
    const route = registry ? findControlUiTabGatewayRoute(registry, tab) : undefined;
    if (route === null) {
      // Dispatch authenticates against its first matching gateway route. Hide
      // a descriptor whose owning plugin cannot receive that request.
      return [];
    }
    const { capabilityBridge, ...tabWithoutCapabilityBridge } = tab;
    const authenticatedRoute = route && opts.requireGatewayAuthGrant !== false;
    return authenticatedRoute
      ? [
          {
            ...tabWithoutCapabilityBridge,
            ...(capabilityBridge ? { capabilityBridge } : {}),
            requiresGatewayAuth: true,
          },
        ]
      : [tabWithoutCapabilityBridge];
  });
}

/** Lists active plugins' trusted widget kinds visible to the presented scopes. */
export function listControlUiPluginWidgetKinds(
  scopes: readonly string[],
): ControlUiPluginWidgetKind[] {
  const entries = getActivePluginSessionExtensionRegistry()?.controlUiDescriptors ?? [];
  const coreEntries = authorizeOperatorScopesForRequiredScope(READ_SCOPE, scopes).allowed
    ? CORE_CONTROL_UI_WIDGET_KINDS
    : [];
  const pluginEntries = entries.flatMap((entry) => {
    const descriptor = entry.descriptor;
    if (descriptor.surface !== "widget") {
      return [];
    }
    const visible = (descriptor.requiredScopes ?? []).every(
      (scope) => authorizeOperatorScopesForRequiredScope(scope, scopes).allowed,
    );
    return visible
      ? [
          {
            pluginId: entry.pluginId,
            kind: `${entry.pluginId}:${descriptor.id}`,
            label: descriptor.label,
          },
        ]
      : [];
  });
  return [...coreEntries, ...pluginEntries].toSorted(
    (left, right) => left.label.localeCompare(right.label) || left.kind.localeCompare(right.kind),
  );
}

/** Builds least-privilege grants only for visible tabs backed by same-plugin gateway routes. */
export function listControlUiPluginTabAuthGrants(
  callerScopes: readonly string[],
): ControlUiPluginTabAuthGrant[] {
  const registry = getActivePluginSessionExtensionRegistry();
  if (!registry || !authorizeOperatorScopesForRequiredScope(READ_SCOPE, callerScopes).allowed) {
    return [];
  }
  const grants = new Map<string, ControlUiPluginTabAuthGrant>();
  for (const tab of projectControlUiPluginTabs(
    registry.controlUiDescriptors ?? [],
    callerScopes,
    [],
    new Map(),
  )) {
    if (!tab.path) {
      continue;
    }
    const route = findControlUiTabGatewayRoute(registry, tab);
    if (!route) {
      continue;
    }
    const key = `${tab.pluginId}\n${route.path}`;
    const existing = grants.get(key);
    if (existing) {
      if (existing.match === "exact" && route.match === "prefix") {
        grants.set(key, { ...existing, match: "prefix" });
      }
      continue;
    }
    grants.set(key, {
      pluginId: tab.pluginId,
      path: route.path,
      match: route.match,
      scopes: [READ_SCOPE],
    });
  }
  return [...grants.values()];
}

function projectCapabilityBridge(
  pluginId: string,
  descriptor: PluginControlUiDescriptor,
  scopes: readonly string[],
  availableMethods: readonly string[],
  initialLinkedSessionKeys: readonly string[],
): ControlUiCapabilityBridgeGrant | undefined {
  const declaration = descriptor.capabilityBridge;
  if (!declaration || descriptor.surface !== "tab") {
    return undefined;
  }
  const available = new Set(availableMethods);
  const registry = getActivePluginSessionExtensionRegistry();
  const registered = new Map(
    (registry?.gatewayMethodDescriptors ?? []).map((method) => [method.name, method]),
  );
  const kind = (method: string): "read" | "write" | "local" | undefined => {
    const core = CORE_BRIDGE_METHODS.get(method);
    if (core) {
      return core;
    }
    const candidate = registered.get(method);
    if (
      candidate?.owner.kind === "plugin" &&
      candidate.owner.pluginId === pluginId &&
      (candidate.scope === READ_SCOPE ||
        candidate.scope === "operator.write" ||
        candidate.scope === "operator.admin")
    ) {
      return candidate.scope === READ_SCOPE ? "read" : "write";
    }
    return undefined;
  };
  const permitted = (method: string) => {
    const methodKind = kind(method);
    if (!methodKind) {
      return false;
    }
    if (methodKind === "local") {
      return authorizeOperatorScopesForRequiredScope(READ_SCOPE, scopes).allowed;
    }
    return (
      available.has(method) &&
      authorizeOperatorScopesForRequiredScope(
        methodKind === "read"
          ? READ_SCOPE
          : !CORE_BRIDGE_METHODS.has(method) && registered.get(method)?.scope === "operator.admin"
            ? "operator.admin"
            : "operator.write",
        scopes,
      ).allowed
    );
  };
  const declared = [...declaration.requiredMethods, ...declaration.optionalMethods];
  const missingRequiredMethods = declaration.requiredMethods.filter((method) => !permitted(method));
  // Unknown required plugin methods are conservative mutations: never leave an
  // optional write enabled when a required capability disappeared after upgrade.
  const missingRequiredWrite = declaration.requiredMethods.some(
    (method) => kind(method) !== "read" && kind(method) !== "local" && !permitted(method),
  );
  const methods = declared.filter(
    (method) => permitted(method) && !(missingRequiredWrite && kind(method) === "write"),
  );
  const readMethods = methods.filter(
    (method) => kind(method) === "read" || kind(method) === "local",
  );
  return {
    protocolVersion: 1,
    mode: methods.some((method) => kind(method) === "write") ? "read-write" : "read-only",
    methods,
    readMethods,
    missingRequiredMethods,
    upgradeRequired: missingRequiredWrite,
    // The authenticated server supplies this immutable, tab-owned input from
    // durable plugin ownership. A browser selection or iframe request is never
    // consulted when granting a port.
    linkedSessionKeys: [...new Set(initialLinkedSessionKeys)]
      .filter((key): key is string => typeof key === "string" && key.length > 0)
      .slice(0, CONTROL_UI_CAPABILITY_BRIDGE_MAX_LINKED_SESSION_KEYS),
    limits: CONTROL_UI_CAPABILITY_BRIDGE_LIMITS,
  };
}
