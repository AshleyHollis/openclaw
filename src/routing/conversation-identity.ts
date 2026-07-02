import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { ChatType } from "../channels/chat-type.js";
import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isAgentMediatedCompletionSourceTool } from "../sessions/input-provenance.js";
import type { AgentRouteMatch } from "./resolve-route.js";
import { normalizeAgentId, parseAgentSessionKey } from "./session-key.js";

export type ConversationCapabilityScope = "direct" | "shared" | "unknown";

export type ConversationIdentityMode = "personal" | "organization" | "external";

export type ConversationIdentityDecision = {
  mode: ConversationIdentityMode;
  allowed: boolean;
  reason:
    | "owner_direct"
    | "bound_service_agent"
    | "unbound_shared"
    | "untrusted_direct"
    | "unknown_audience"
    | "disallowed_inter_session"
    | "unconfigured_agent"
    | "stale_route"
    | "internal";
};

export type ConversationIdentityParams = {
  config?: OpenClawConfig;
  /** Trusted scheduler/system turns stay inside their already-admitted session. */
  isInternal?: boolean;
  agentId?: string;
  /** Trusted current parent-to-child ownership revalidated by the host. */
  agentIsLiveOwnedChild?: boolean;
  routeMatchedBy?: AgentRouteMatch;
  chatType?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  senderIsOwner?: boolean;
};

export const EXTERNAL_CONVERSATION_IDENTITY_DENIAL =
  "This conversation is not bound to a shared service agent. Ask an operator to configure an explicit agent binding for this audience.";

export function isConversationIdentityPersistedAgentCurrent(params: {
  config?: OpenClawConfig;
  agentId?: string;
}): boolean {
  const config = params.config ?? {};
  const agentId = normalizeAgentId(params.agentId ?? resolveDefaultAgentId(config));
  const configuredAgents = config.agents?.list ?? [];
  if (configuredAgents.length === 0) {
    if (agentId === normalizeAgentId(resolveDefaultAgentId(config))) {
      return true;
    }
    // Legacy implicit registries can still name a service agent through an explicit binding.
    // The binding remains the current configuration owner until it is removed.
    return (config.bindings ?? []).some((binding) => normalizeAgentId(binding.agentId) === agentId);
  }
  return configuredAgents.some((entry) => normalizeAgentId(entry.id) === agentId);
}

export function resolveStableSenderIsOwner(params: {
  senderId?: string | null;
  commandOwnerAllowFrom?: Array<string | number> | null;
  providerAllowFrom?: Array<string | number> | null;
  normalizeEntry: (entry: string) => string | null | undefined;
}): boolean {
  const senderId = params.senderId ? params.normalizeEntry(params.senderId) : null;
  if (!senderId || senderId === "*") {
    return false;
  }
  const normalizeOwners = (entries: Array<string | number>) =>
    entries.flatMap((entry) => {
      const rawEntry = String(entry).trim();
      const normalized = rawEntry === "*" ? null : params.normalizeEntry(rawEntry);
      return normalized && normalized !== "*" ? [normalized] : [];
    });
  const commandOwners = normalizeOwners(params.commandOwnerAllowFrom ?? []);
  const owners =
    commandOwners.length > 0 ? commandOwners : normalizeOwners(params.providerAllowFrom ?? []);
  return owners.includes(senderId);
}

export function isInterSessionIdentityTransitionAllowed(params: {
  config?: OpenClawConfig;
  sourceSessionKey?: string;
  sourceTool?: string;
  targetAgentId?: string;
  targetIsLiveOwnedChild?: boolean;
}): boolean {
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(params.config ?? {}));
  const targetAgentId = normalizeAgentId(params.targetAgentId ?? defaultAgentId);
  if (
    !params.targetIsLiveOwnedChild &&
    !isConversationIdentityPersistedAgentCurrent({
      config: params.config,
      agentId: targetAgentId,
    })
  ) {
    return false;
  }
  if (isAgentMediatedCompletionSourceTool(params.sourceTool)) {
    return true;
  }
  const sourceAgentId = parseAgentSessionKey(params.sourceSessionKey)?.agentId;
  if (!sourceAgentId) {
    return false;
  }
  // Existing agent-to-agent policy authorizes service peers. This boundary only
  // prevents a shared service identity from re-entering the personal default.
  return (
    sourceAgentId === targetAgentId ||
    sourceAgentId === defaultAgentId ||
    targetAgentId !== defaultAgentId
  );
}

export function resolveConversationIdentityMode(
  params: ConversationIdentityParams,
): ConversationIdentityDecision {
  if (
    params.agentIsLiveOwnedChild !== true &&
    !isConversationIdentityPersistedAgentCurrent({
      config: params.config,
      agentId: params.agentId,
    })
  ) {
    return { mode: "external", allowed: false, reason: "unconfigured_agent" };
  }
  if (params.isInternal === true) {
    return { mode: "personal", allowed: true, reason: "internal" };
  }
  const scope = resolveConversationScope(params);
  if (scope === "unknown") {
    return { mode: "external", allowed: false, reason: "unknown_audience" };
  }

  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(params.config ?? {}));
  const agentId = normalizeAgentId(params.agentId ?? defaultAgentId);
  const configuredAgents = params.config?.agents?.list ?? [];
  const agentIsConfigured = configuredAgents.some(
    (entry) => normalizeAgentId(entry.id) === agentId,
  );
  const configuredAgentTarget =
    params.routeMatchedBy === "config.agent"
      ? agentIsConfigured
      : configuredAgents.length === 0 || agentIsConfigured;
  // Shared audiences may cross the personal boundary only through a configured route
  // to a distinct service agent. A default route never proves that separation.
  const usesServiceAgent =
    agentId !== defaultAgentId &&
    configuredAgentTarget &&
    params.routeMatchedBy !== undefined &&
    params.routeMatchedBy !== "default";
  if (usesServiceAgent) {
    return { mode: "organization", allowed: true, reason: "bound_service_agent" };
  }
  if (scope === "direct" && agentId === defaultAgentId && params.senderIsOwner === true) {
    return { mode: "personal", allowed: true, reason: "owner_direct" };
  }
  return scope === "shared"
    ? { mode: "external", allowed: false, reason: "unbound_shared" }
    : { mode: "external", allowed: false, reason: "untrusted_direct" };
}

export function resolveConversationScope(
  params: Pick<ConversationIdentityParams, "chatType" | "groupId" | "groupChannel" | "groupSpace">,
): ConversationCapabilityScope {
  const chatType: ChatType | undefined = normalizeChatType(params.chatType);
  if (chatType === "direct") {
    return "direct";
  }
  if (chatType === "group" || chatType === "channel") {
    return "shared";
  }
  return params.groupId?.trim() || params.groupChannel?.trim() || params.groupSpace?.trim()
    ? "shared"
    : "unknown";
}
