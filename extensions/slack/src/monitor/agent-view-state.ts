// Slack plugin module owns durable Agent View mode state.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getOptionalSlackRuntime } from "../runtime.js";

const SLACK_AGENT_VIEW_STATE_NAMESPACE = "agent-view-workspaces";
const SLACK_AGENT_VIEW_STATE_MAX_ENTRIES = 1024;

type StoredSlackAgentViewState = {
  experience: "agent";
  observedAt: number;
};

export function createSlackAgentViewState(params: {
  accountId: string;
  teamId: string;
  warn: (action: string, error: unknown) => void;
}) {
  let enabled = false;
  let loaded = false;
  let persisted = false;
  let store: PluginStateKeyedStore<StoredSlackAgentViewState> | null | undefined;
  let warned = false;

  const warnOnce = (action: string, error: unknown) => {
    if (warned) {
      return;
    }
    warned = true;
    params.warn(action, error);
  };

  const openStore = () => {
    if (store !== undefined) {
      return store ?? undefined;
    }
    const runtime = getOptionalSlackRuntime();
    if (!runtime) {
      return undefined;
    }
    try {
      // Slack cannot switch an app back to Assistant View, so this marker has no TTL.
      // Keeping it durable prevents post-restart follow-ups from collapsing into the base DM.
      store = runtime.state.openKeyedStore<StoredSlackAgentViewState>({
        namespace: SLACK_AGENT_VIEW_STATE_NAMESPACE,
        maxEntries: SLACK_AGENT_VIEW_STATE_MAX_ENTRIES,
      });
      return store;
    } catch (error) {
      store = null;
      warnOnce("open", error);
      return undefined;
    }
  };

  const stateKey = `${params.accountId}:${params.teamId}`;
  const record = async () => {
    enabled = true;
    loaded = true;
    if (persisted) {
      return;
    }
    const openedStore = openStore();
    if (!openedStore) {
      return;
    }
    try {
      await openedStore.register(stateKey, { experience: "agent", observedAt: Date.now() });
      persisted = true;
    } catch (error) {
      warnOnce("persist", error);
    }
  };

  const isEnabled = async () => {
    if (enabled) {
      return true;
    }
    if (loaded) {
      return false;
    }
    const openedStore = openStore();
    if (!openedStore) {
      return false;
    }
    try {
      const stored = await openedStore.lookup(stateKey);
      loaded = true;
      enabled = stored?.experience === "agent";
      persisted = enabled;
      return enabled;
    } catch (error) {
      warnOnce("load", error);
      return false;
    }
  };

  return { isEnabled, record };
}
