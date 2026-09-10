/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createPluginPanelPromotion } from "./chat-pane-plugin-panel-promotion.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { openSlot } from "./sidebar-layout.ts";

const fixture = () =>
  createTestChatPane({
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    sessions: {} as SessionCapability,
  });

it("promotes the bound pane despite unrelated global agent selection, using its latest layout", () => {
  const { pane, state } = fixture();
  state.sessionKey = "agent:bound:fixture";
  const slot = "plugin:fixture/notes";
  const promote = createPluginPanelPromotion(state, "bound", () => true);
  pane.context.agentSelection.state.selectedId = "another";
  state.sidebarLayout = openSlot({ columns: [] }, slot);
  const update = vi.spyOn(state, "updateSidebarLayout");
  promote(slot);
  expect(update).toHaveBeenCalledOnce();
  expect(state.sidebarLayout.mainPanelId).toBe(slot);
});

it.each(["session", "agent", "hidden", "closed"])(
  "refuses a retained promotion after its %s changes",
  (change) => {
    const { state } = fixture();
    state.sessionKey = "agent:bound:fixture";
    const slot = "plugin:fixture/notes";
    state.sidebarLayout = openSlot({ columns: [] }, slot);
    let presented = true;
    const promote = createPluginPanelPromotion(
      state,
      change === "agent" ? "former" : "bound",
      () => presented,
    );
    if (change === "session") {
      state.sessionKey = "agent:bound:successor";
    }
    if (change === "hidden") {
      presented = false;
    }
    if (change === "closed") {
      state.sidebarLayout = { columns: [] };
    }
    const update = vi.spyOn(state, "updateSidebarLayout");
    promote(slot);
    expect(update).not.toHaveBeenCalled();
  },
);
