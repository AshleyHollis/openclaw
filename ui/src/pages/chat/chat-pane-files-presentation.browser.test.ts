// Actual mounted Files replacement and host promotion in the browser.
import { html, render, type LitElement } from "lit";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiViewContext } from "../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../app/context.ts";
import { createControlUiPluginHost } from "../../plugins/control-ui-host.ts";
import {
  ControlUiPluginRuntime,
  type ControlUiPluginOwner,
} from "../../plugins/control-ui-runtime.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createReviewFixture } from "../../test-helpers/chat-pane-embedded-panels.ts";
import "../../test-helpers/load-styles.ts";
import { createChatPaneRails } from "./chat-pane-rails.ts";
import { ChatPane } from "./chat-pane-render.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { openSlot, sidebarMainPanel } from "./sidebar-layout.ts";
import "../../plugins/control-ui-view.runtime.ts";

class FilesPresentationFixture extends ChatPane {
  override render() {
    return html``;
  }
  renderFixture(context: ApplicationContext, state: ChatPageHost) {
    this.context = context;
    this.state = state;
    this.compact = true;
    // This explicitly rendered sibling fixture has a desktop main/side layout.
    this.paneWidth = 1280;
    const rails = createChatPaneRails({
      state,
      sidebarLayout: state.sidebarLayout,
      presentationId: "fictional-files",
      presented: true,
      gatewaySnapshot: context.gateway.snapshot,
      setObserverVisibility: vi.fn(),
      updateSidebarLayout: state.updateSidebarLayout,
    });
    return this.renderChatPaneLayout({
      state,
      selectedSession: undefined,
      currentAgentId: "main",
      board: this.resolveBoardView(),
      sidebarLayout: state.sidebarLayout,
      sessionWorkspace: rails.sessionWorkspace,
      chatProps: createChatProps({
        paneId: "fictional-files",
        sessionKey: state.sessionKey,
        transcript: this.transcript,
        draft: state.chatMessage,
        getDraft: () => state.chatMessage,
      }),
      observerDigest: null,
      observerRunId: null,
      catalog: false,
      agentWorkspace: undefined,
      workspaceGit: false,
      openPanelSlot: rails.openPanelSlot,
      closePanelSlot: rails.closePanelSlot,
    });
  }
}
customElements.define("files-presentation-fixture", FilesPresentationFixture);

it.runIf("__vitest_browser__" in globalThis)(
  "mounts the Files replacement with the host-owned promotion callback",
  async () => {
    const { page } = await import("vitest/browser");
    await page.viewport(1280, 900);
    const { state, mount } = createReviewFixture();
    state.sidebarLayout = openSlot(openSlot({ columns: [] }, "conversation"), "workspace");
    state.chatMessage = "Fictional unsent draft";
    const sessionKey = state.sessionKey;
    const workspace = state.sidebarLayout.columns
      .flatMap((column) => column.panels)
      .find((panel) => panel.slot === "workspace");
    const client = createGatewayBrowserClientFixture({
      request: (method) => {
        if (method === "agents.list") {
          return {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "main" }],
          };
        }
        return method === "sessions.describe" ? { session: null } : {};
      },
    });
    const runtime = new ControlUiPluginRuntime(() => context);
    const baseContext = createInitializationContext(client);
    const context: ApplicationContext = {
      ...baseContext,
      config: { ...baseContext.config, subscribe: () => () => {} },
      plugins: runtime,
    };
    runtime.start();
    const owner: Omit<ControlUiPluginOwner, "host"> = {
      descriptor: {
        pluginId: "fictional-files",
        name: "Fictional files",
        revision: "fixture",
        entryUrl: "/fictional-files/index.js",
        styles: [],
      },
      client,
      abort: new AbortController(),
      disposers: new Set(),
      contributions: {
        pages: new Map(),
        navigation: new Map(),
        panels: new Map(),
        actions: new Map(),
        replacements: new Map(),
        accessories: new Map(),
        widgets: new Map(),
      },
      selections: new Map(),
    };
    const host = createControlUiPluginHost(() => context, runtime, owner);
    let mountedPanel: ControlUiViewContext["panel"];
    let mounted = false;
    const unregister = host.ui.registerReplacement({
      id: "files",
      label: "Fictional files",
      surface: "session-files",
      mount(container, viewContext) {
        mounted = true;
        mountedPanel = viewContext.panel;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Show Files in main";
        button.dataset.fixtureShowFiles = "";
        button.addEventListener("click", () => viewContext.panel?.showInMain());
        container.append(button);
      },
    });
    const contribution = owner.contributions.replacements.get("files");
    if (!contribution) throw new Error("Fictional Files contribution was not registered");
    vi.spyOn(runtime, "selectedReplacement").mockImplementation((surface) =>
      surface === "session-files"
        ? {
            key: "fictional-files/files",
            pluginId: "fictional-files",
            value: contribution.value,
            host,
            signal: contribution.signal,
          }
        : undefined,
    );
    const provider = createApplicationContextProvider(context);
    mount.append(provider);
    const fixture = document.createElement(
      "files-presentation-fixture",
    ) as FilesPresentationFixture;
    fixture.paneId = "fictional-files";
    fixture.presentationId = "fictional-files";
    fixture.sessionKey = sessionKey;
    const output = document.createElement("div");
    provider.append(fixture, output);
    onTestFinished(async () => {
      unregister();
      owner.abort.abort();
      fixture.remove();
      provider.remove();
      await vi.dynamicImportSettled();
      runtime.dispose();
    });
    render(fixture.renderFixture(context, state), output, { host: fixture });
    await fixture.updateComplete;
    await output.querySelector<LitElement>("openclaw-chat-sidebar-region")?.updateComplete;
    const beforeScreenshot = await page.screenshot({
      path: "__screenshots__/life-stable-focused/files-before-promotion-or-unsupported.png",
      save: true,
    });
    console.info(
      `[life-stable-visual] Files before promotion: ${beforeScreenshot}; ${JSON.stringify({
        replacementMounted: mounted,
        hasPromotion: typeof mountedPanel?.showInMain === "function",
      })}`,
    );
    await vi.waitFor(() => expect(mounted, "Files replacement must mount").toBe(true));
    const filesPanel = output.querySelector<HTMLElement>('[data-panel-slot="workspace"]')!;
    expect(filesPanel.getAttribute("data-region")).toBe("side");
    expect(filesPanel.contains(output.querySelector("[data-fixture-show-files]"))).toBe(true);
    expect(
      mountedPanel?.showInMain,
      "Mounted Files replacement must expose host promotion",
    ).toBeTypeOf("function");
    await page
      .elementLocator(output.querySelector<HTMLButtonElement>("[data-fixture-show-files]")!)
      .click();
    // Publish the existing host's updated layout into this explicitly rendered fixture.
    render(fixture.renderFixture(context, state), output, { host: fixture });
    await fixture.updateComplete;
    await output.querySelector<LitElement>("openclaw-chat-sidebar-region")?.updateComplete;
    await expect
      .element(output.querySelector<HTMLButtonElement>("[data-fixture-show-files]")!)
      .toBeVisible();
    await expect
      .element(output.querySelector<HTMLTextAreaElement>("textarea")!)
      .toBeVisible();
    await expect
      .element(output.querySelector<HTMLTextAreaElement>("textarea")!)
      .toHaveValue("Fictional unsent draft");
    const afterScreenshot = await page.screenshot({
      path: "__screenshots__/life-stable-focused/files-after-promotion.png",
      save: true,
    });
    console.info(`[life-stable-visual] Files after promotion: ${afterScreenshot}`);
    expect(output.querySelector('[data-panel-slot="workspace"]')?.getAttribute("data-region")).toBe(
      "main",
    );
    expect(sidebarMainPanel(state.sidebarLayout)?.id).toBe(workspace?.id);
    expect(state.sessionKey).toBe(sessionKey);
    expect(state.chatMessage).toBe("Fictional unsent draft");
  },
);
