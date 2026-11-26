/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { ValueSignal } from "../../lib/board/provider-signals.ts";
import { createMockBoardProvider } from "../../test-helpers/board-provider.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import {
  createDetailsOutputsBinding,
  projectDetailsOutputs,
} from "./chat-details-outputs-binding.ts";
import { ChatPaneHeaderLayout } from "./chat-pane-header-layout.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatProps } from "./chat-view.tsx";
import { ChatOutputsDesktop, ChatOutputsMobile } from "./components/chat-outputs.tsx";
import {
  getChatSessionWorkspace,
  getSessionWorkspace,
  refreshSessionWorkspaceState,
} from "./components/chat-session-workspace-state.ts";

function boardFixture(sessionKey: string, initiallyLoaded = false) {
  const mock = createMockBoardProvider(sessionKey);
  const provider = {
    ...mock,
    hasLoadedSnapshot: initiallyLoaded,
    snapshot$: new ValueSignal<ResolvedBoardView["snapshot"]>({
      ...mock.snapshot$.value,
      tabs: [],
      widgets: [],
    }),
    loadError$: new ValueSignal<string | null>(null),
  };
  return {
    provider,
    fail: () => provider.loadError$.set("Dashboard request failed"),
    resolve(withContent = false) {
      provider.hasLoadedSnapshot = true;
      provider.snapshot$.set(withContent ? mock.snapshot$.value : provider.snapshot$.value);
      provider.loadError$.set(null);
    },
  };
}

function mountOutputs(
  options: { desktop?: boolean; acquired?: boolean; loaded?: boolean; files?: boolean } = {},
) {
  const { pane, state } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
  const workspace = getSessionWorkspace(state);
  workspace.assistantArtifacts = {
    items: options.files
      ? [{ id: "report", type: "file", title: "Report.txt", download: { mode: "bytes" } }]
      : [],
    resolved: true,
    loaded: true,
    loading: false,
    error: null,
  };
  let board = boardFixture(state.sessionKey, options.loaded);
  const readBoard = (): ResolvedBoardView => ({
    provider: board.provider,
    snapshot: board.provider.snapshot$.value,
    available: true,
    hasBoard: board.provider.snapshot$.value.widgets.length > 0,
    face: "chat",
    activeTabId: "main",
  });
  const openDashboard = vi.fn();
  const context = {
    gateway: () => pane.context.gateway,
    state: () => state,
    isConnected: () => true,
    presented: () => true,
    presentation: () => undefined,
    readBoard,
    showDashboard: openDashboard,
  };
  const bind = (acquired = true) =>
    createDetailsOutputsBinding(context, state, workspace, board.provider, acquired);
  let binding = bind(options.acquired);
  const read = () => projectDetailsOutputs(binding, workspace, readBoard()).outputs!;
  const [outputs, setOutputs] = createSignal(read());
  const draw = () => {
    setOutputs(read());
    flush();
  };
  const view = mountSolid(() =>
    options.desktop ? <ChatOutputsDesktop {...outputs()} /> : <ChatOutputsMobile {...outputs()} />,
  );
  onTestFinished(() => {
    binding.stop();
    view.unmount();
  });
  return {
    ...view,
    openDashboard,
    button: (name: string) => view.getByRole("button", { name }),
    status: (text?: string) =>
      waitForSolid(() => {
        if (text) {
          expect(view.getByRole("status").textContent).toContain(text);
        } else {
          expect(view.queryByRole("status")).toBeNull();
        }
      }),
    fail() {
      board.fail();
      draw();
    },
    resolve(withContent = false) {
      board.resolve(withContent);
      draw();
    },
    acquire() {
      binding.stop();
      binding = bind();
      draw();
    },
    replace() {
      const previous = board;
      binding.stop();
      board = boardFixture(state.sessionKey, true);
      board.resolve(true);
      binding = bind();
      draw();
      return previous;
    },
    retainAndReleaseFiles() {
      binding.retain()?.();
    },
  };
}

it("waits for acquisition even when the initial provider reports a loaded empty snapshot", async () => {
  const view = mountOutputs({ acquired: false, loaded: true });
  await view.status("Loading dashboard");
  expect(view.queryByText("No outputs yet")).toBeNull();
  view.acquire();
  await waitForSolid(() => expect(view.queryByText("Loading dashboard…")).toBeNull());
  expect(view.container.textContent).toContain("No outputs yet");
});

it.each([false, true])(
  "keeps files usable through dashboard failure and owner recovery (desktop=%s)",
  async (desktop) => {
    const view = mountOutputs({ desktop, files: true });
    await waitForSolid(() => expect(view.button("Report.txt")).toBeTruthy());
    view.fail();
    await view.status("Dashboard request failed");
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(view.button("Report.txt")).toBeTruthy();
    view.resolve(true);
    await view.status();
    view.button("Overview").click();
    expect(view.openDashboard).toHaveBeenCalledOnce();
  },
);

it("keeps dashboard readiness alive when Files demand is released and retires pending providers", async () => {
  const view = mountOutputs();
  view.retainAndReleaseFiles();
  await view.status("Loading dashboard");
  const previous = view.replace();
  await waitForSolid(() => expect(view.button("Overview")).toBeTruthy());
  previous.fail();
  previous.resolve();
  await view.status();
  expect(view.button("Overview")).toBeTruthy();
});

it("keeps Chat Outputs requests on Chat while Files presents another conversation", async () => {
  const artifact = {
    id: "report",
    type: "file",
    title: "Report.txt",
    mimeType: "text/plain",
    download: { mode: "bytes" },
  };
  const request = vi.fn(async (method: string, _params?: unknown, _options?: unknown) => {
    if (method === "artifacts.list") {
      return { artifacts: [artifact] };
    }
    if (method === "artifacts.download") {
      return { artifact, encoding: "base64", data: btoa("Chat A output") };
    }
    return {};
  });
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
  });
  const chat = getChatSessionWorkspace(state);
  state.sessionWorkspaceTarget = {
    sessionKey: "agent:fictional:files",
    agentId: "fictional",
    chatSessionKey: state.sessionKey,
    connectionEpoch: state.connectionEpoch,
  };
  const files = getSessionWorkspace(state);
  const provider = boardFixture(state.sessionKey, true).provider;
  const board: ResolvedBoardView = {
    provider,
    snapshot: provider.snapshot$.value,
    available: false,
    hasBoard: false,
    face: "chat",
    activeTabId: "main",
  };
  const binding = createDetailsOutputsBinding(
    {
      gateway: () => pane.context.gateway,
      state: () => state,
      isConnected: () => true,
      presented: () => true,
      presentation: () => "desktop",
      readBoard: () => board,
      showDashboard: vi.fn(),
    },
    state,
    chat,
    provider,
    false,
  );
  onTestFinished(binding.stop);
  binding.retain();
  await vi.waitFor(() => expect(chat.assistantArtifacts?.loaded).toBe(true));
  expect(projectDetailsOutputs(binding, chat, board).outputs?.artifacts).toEqual([artifact]);
  expect(files.assistantArtifacts).toBeUndefined();
  binding.onRetryArtifacts();
  await vi.waitFor(() =>
    expect(request.mock.calls.filter(([method]) => method === "artifacts.list")).toHaveLength(2),
  );
  refreshSessionWorkspaceState(state, false);
  await vi.waitFor(() =>
    expect(request.mock.calls.filter(([method]) => method === "artifacts.list")).toHaveLength(3),
  );
  for (const call of request.mock.calls.filter(([method]) => method === "artifacts.list")) {
    expect(call).toEqual([
      "artifacts.list",
      { sessionKey: state.sessionKey, agentId: "main", messageRole: "assistant" },
    ]);
  }
  binding.onOpenArtifact("report");
  await vi.waitFor(() =>
    expect(files.previews.at(-1)?.content).toMatchObject({
      kind: "file",
      content: "Chat A output",
    }),
  );
  expect(request).toHaveBeenCalledWith(
    "artifacts.download",
    {
      sessionKey: state.sessionKey,
      agentId: "main",
      artifactId: "report",
    },
    { timeoutMs: 30_000 },
  );
  expect(getSessionWorkspace(state)).toBe(files);
  expect(state.sessionWorkspaceTarget?.sessionKey).toBe("agent:fictional:files");
  binding.onViewAll();
  expect(getSessionWorkspace(state)).toBe(chat);
  expect(state.sessionWorkspaceTarget).toMatchObject({
    sessionKey: state.sessionKey,
    agentId: "main",
  });
});

// Exercise the real header composition with the retained pane's current owners.
abstract class HeaderDetailsProbe extends ChatPaneHeaderLayout {
  static capture(pane: unknown, state: ChatPageHost) {
    const chat = {} as ChatProps;
    return HeaderDetailsProbe.prototype.renderHeaderDetails.call(pane as HeaderDetailsProbe, {
      elements: {},
      state,
      selectedSession: undefined,
      chatProps: chat,
      paneChatProps: chat,
      detailsActions: {},
      subagentStop: undefined,
      ownsSubagentsPanel: true,
      mobileHost: undefined,
      sidebarLayout: state.sidebarLayout,
      headerPresentation: true,
      panePresentation: true,
      conversationVisible: true,
    }).headerDetails;
  }
}

it("opens Chat's uncommitted changes from Details while Files targets another conversation", async () => {
  const request = vi.fn(async () => ({ files: [] }));
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
  });
  state.hello = gatewayHelloForMethods(["sessions.diff"]);
  const chat = getChatSessionWorkspace(state);
  state.sessionWorkspaceTarget = {
    sessionKey: "agent:fictional:files",
    agentId: "fictional",
    chatSessionKey: state.sessionKey,
    connectionEpoch: state.connectionEpoch,
  };
  const files = getSessionWorkspace(state);
  const details = HeaderDetailsProbe.capture(pane, state);
  expect(details?.chat?.environment?.onOpenUncommitted).toBeTypeOf("function");
  details?.chat?.environment?.onOpenUncommitted?.();
  const content = state.sidebarContent;
  expect(content).toMatchObject({
    kind: "session-diff",
    owner: chat,
    presentation: { scopeRequest: { owner: chat, scope: { scope: "uncommitted" } } },
  });
  if (content?.kind !== "session-diff") {
    throw new Error("Expected Chat's diff to open");
  }
  await content.load({ scope: "uncommitted" });
  expect(request).toHaveBeenCalledWith("sessions.diff", {
    sessionKey: state.sessionKey,
    agentId: "main",
    scope: "uncommitted",
    poll: true,
  });
  expect(getSessionWorkspace(state)).toBe(files);
});
