import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { isSidebarSlotVisible, promoteSidebarPanel, type SidebarSlotId } from "./sidebar-layout.ts";

/** Retain the pane's identity, not the application's independently selected agent. */
export function createPluginPanelPromotion(
  state: ChatPageHost,
  agentId: string,
  presented: () => boolean,
) {
  const sessionKey = state.sessionKey;
  return (slot: SidebarSlotId) => {
    if (state.sessionKey !== sessionKey || resolveChatAgentId(state) !== agentId || !presented()) {
      return;
    }
    const layout = state.sidebarLayout;
    const panel = layout.columns
      .flatMap((column) => column.panels)
      .find((entry) => entry.slot === slot);
    if (panel && isSidebarSlotVisible(layout, slot)) {
      state.updateSidebarLayout(promoteSidebarPanel(layout, panel.id));
    }
  };
}
