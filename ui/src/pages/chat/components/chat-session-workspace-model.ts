import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionScopeHostWithKey } from "../../../lib/sessions/index.ts";
import { scopedAgentParamsForSession } from "../../../lib/sessions/navigation.ts";
import {
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../../lib/sessions/session-key.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";

export function resolvePaneAgent(state: SessionScopeHostWithKey): string {
  if (normalizeOptionalString(state.sessionKey)?.toLowerCase() !== "global") {
    return resolveAgentIdFromSessionKey(state.sessionKey);
  }
  return (
    scopedAgentParamsForSession(state, state.sessionKey).agentId ??
    normalizeAgentId(
      state.assistantAgentId ??
        state.agentsList?.defaultId ??
        state.agentsList?.agents?.[0]?.id ??
        "main",
    )
  );
}

export function resolveSessionWorkspaceTarget(state: SessionWorkspaceHost) {
  const target = state.sessionWorkspaceTarget;
  if (
    target &&
    target.chatSessionKey === state.sessionKey &&
    target.connectionEpoch === state.connectionEpoch
  ) {
    return {
      sessionKey: target.sessionKey,
      agentId: normalizeOptionalString(target.agentId)
        ? normalizeAgentId(target.agentId)
        : resolvePaneAgent({ ...state, sessionKey: target.sessionKey }),
    };
  }
  if (target) {
    delete state.sessionWorkspaceTarget;
  }
  return { sessionKey: state.sessionKey, agentId: resolvePaneAgent(state) };
}

export function createSessionWorkspaceState(
  state: SessionWorkspaceHost,
  target = resolveSessionWorkspaceTarget(state),
): SessionWorkspaceState {
  return {
    tree: {
      expandedPaths: [""],
      searchOpen: false,
      sessionExpanded: true,
      treeVisible: true,
      treeScroll: 0,
      sessionScroll: 0,
    },
    directories: Object.create(null),
    artifacts: { items: [], resolved: false, loaded: false, loading: false, error: null },
    previews: [],
    activePreviewId: null,
    activeId: null,
    agentId: target.agentId,
    browserPath: "",
    browserSearch: "",
    filter: "all",
    browserSearchTimer: null,
    connectionEpoch: state.connectionEpoch,
    error: null,
    list: null,
    loading: false,
    pendingReload: false,
    sessionKey: target.sessionKey,
  };
}
