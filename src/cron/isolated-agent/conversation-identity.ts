import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveConversationIdentityMode } from "../../routing/conversation-identity.js";
import {
  resolvePersistedConversationIdentityContext,
  type PersistedConversationIdentityContext,
  type PersistedPluginConversationRouteResolver,
} from "../../routing/persisted-conversation-identity.js";
import type { CronSessionTarget } from "../types.js";

export type CronConversationIdentityContext = PersistedConversationIdentityContext;

/** Revalidates persistent channel sessions against the current registry and binding config. */
export async function resolveCronConversationIdentityContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionTarget: CronSessionTarget;
  sessionEntry?: SessionEntry;
  resolvePluginRoute?: PersistedPluginConversationRouteResolver;
}): Promise<CronConversationIdentityContext> {
  const currentAgent = resolveConversationIdentityMode({
    config: params.cfg,
    agentId: params.agentId,
    isInternal: true,
  });
  if (!currentAgent.allowed || params.sessionTarget === "isolated") {
    return { decision: currentAgent };
  }
  return await resolvePersistedConversationIdentityContext({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    audienceless: "internal",
    requireAgentSessionKey: true,
    resolvePluginRoute: params.resolvePluginRoute,
  });
}
