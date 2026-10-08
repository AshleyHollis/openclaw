import { describe, expect, it, vi } from "vitest";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "../chat-pane.test-support.ts";
import {
  getSessionWorkspace,
  retireSessionWorkspaceCheckout,
  refreshSessionWorkspaceState,
} from "./chat-session-workspace-state.ts";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";

function fixture() {
  let resolve!: (value: SessionWorkspaceListResult) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<SessionWorkspaceListResult>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const listing: SessionWorkspaceListResult = {
    sessionKey: "agent:main:current",
    root: "/workspace",
    files: [],
    artifacts: [],
    browser: { path: "", entries: [] },
  };
  const listFiles = vi
    .fn()
    .mockResolvedValueOnce(listing)
    .mockReturnValueOnce(pending)
    .mockResolvedValue(listing);
  const state: SessionWorkspaceHost = {
    client: createGatewayBrowserClientFixture({ request: () => ({ artifacts: [] }) }),
    connected: true,
    connectionEpoch: 1,
    sessionKey: listing.sessionKey,
    hello: null,
    agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    sidebarContent: null,
    handleOpenSidebar: () => {},
    requestUpdate: vi.fn(),
    sessions: createSessionCapabilityFixture({
      listFiles,
      getFile: async () => ({
        sessionKey: listing.sessionKey,
        root: "/workspace",
        file: {
          path: "reports/inventory.csv",
          workspacePath: "reports/inventory.csv",
          name: "inventory.csv",
          kind: "read",
          missing: false,
          content: "item,count\nnotebooks,3",
        },
      }),
    }),
  };
  return { state, listing, listFiles, resolve, reject };
}

describe("workspace listing ownership", () => {
  it("keeps Files B independent of Chat A and rejects B results after Files C", async () => {
    const { state, listFiles, resolve } = fixture();
    state.sessionWorkspaceTarget = { sessionKey: "agent:writer:files-b", agentId: "writer" };
    createSessionWorkspaceProps(state, { expanded: true });
    await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
    const filesB = getSessionWorkspace(state);
    expect(listFiles).toHaveBeenLastCalledWith(
      "agent:writer:files-b",
      expect.objectContaining({ agentId: "writer" }),
    );
    expect(refreshSessionWorkspaceState(state, true)).toBe(false);
    retireSessionWorkspaceCheckout(state);
    expect(getSessionWorkspace(state)).toBe(filesB);
    createSessionWorkspaceProps(state).onRefresh();
    state.sessionWorkspaceTarget = { sessionKey: "agent:research:files-c", agentId: "research" };
    const filesC = getSessionWorkspace(state);
    resolve({ sessionKey: "agent:writer:files-b", files: [], artifacts: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(getSessionWorkspace(state)).toBe(filesC);
    expect(filesC.list).toBeNull();
    expect(state.sessionKey).toBe("agent:main:current");
    state.connectionEpoch++;
    expect(getSessionWorkspace(state)).not.toBe(filesC);
  });

  it("targets the source Chat when opening its file after independent Files", async () => {
    const { state } = fixture();
    const getFile = vi.spyOn(state.sessions, "getFile");
    state.sessionWorkspaceTarget = { sessionKey: "agent:writer:files-b", agentId: "writer" };
    openSessionWorkspaceFile(state, {
      path: "reports/inventory.csv",
      sessionKey: state.sessionKey,
    });
    expect(getFile).toHaveBeenCalledWith(
      "agent:main:current",
      "reports/inventory.csv",
      expect.objectContaining({ agentId: "main" }),
    );
    expect(state.sessionKey).toBe("agent:main:current");
  });

  it.each(["success", "failure"] as const)(
    "ignores an old directory %s after browsing elsewhere",
    async (outcome) => {
      const { state, listing, listFiles, resolve, reject } = fixture();
      createSessionWorkspaceProps(state, { expanded: true });
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
      const props = createSessionWorkspaceProps(state);
      props.onRefresh();
      props.onBrowsePath("reports");
      if (outcome === "success") {
        resolve(listing);
      } else {
        reject(new Error("old directory unavailable"));
      }
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
      expect(createSessionWorkspaceProps(state).error).toBeNull();
      expect(createSessionWorkspaceProps(state).list).toBeNull();
      createSessionWorkspaceProps(state, { expanded: true });
      await vi.waitFor(() => expect(listFiles).toHaveBeenCalledTimes(3));
      expect(listFiles).toHaveBeenLastCalledWith(state.sessionKey, {
        path: "reports",
        search: "",
        agentId: "main",
      });
    },
  );

  it.each(["success", "failure"] as const)(
    "ignores an old search %s without bypassing debounce",
    async (outcome) => {
      const { state, listing, listFiles, resolve, reject } = fixture();
      createSessionWorkspaceProps(state, { expanded: true });
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
      vi.useFakeTimers();
      try {
        const props = createSessionWorkspaceProps(state);
        props.onRefresh();
        props.onSearch("inventory");
        if (outcome === "success") {
          resolve(listing);
        } else {
          reject(new Error("old search unavailable"));
        }
        await vi.advanceTimersByTimeAsync(0);
        const settled = createSessionWorkspaceProps(state, { expanded: true });
        expect(settled.loading).toBe(false);
        expect(settled.error).toBeNull();
        expect(settled.list).toBeNull();
        expect(listFiles).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(159);
        expect(listFiles).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(listFiles).toHaveBeenCalledTimes(3);
        expect(listFiles).toHaveBeenLastCalledWith(state.sessionKey, {
          path: "",
          search: "inventory",
          agentId: "main",
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "preserves file intent across missing rows (reopen: %s)",
    async (reopen) => {
      const { state, listing, listFiles, resolve } = fixture();
      createSessionWorkspaceProps(state, { expanded: true });
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
      if (reopen) {
        openSessionWorkspaceFile(state, { path: "reports/inventory.csv" });
        await vi.waitFor(() =>
          expect(state.sessionWorkspaceState?.previews[0]?.content.kind).toBe("file"),
        );
      }
      createSessionWorkspaceProps(state).onRefresh();
      openSessionWorkspaceFile(state, { path: "reports/inventory.csv" });
      await vi.waitFor(() =>
        expect(state.sessionWorkspaceState?.previews[0]?.content.kind).toBe("file"),
      );
      const selected = createSessionWorkspaceProps(state).activeId;
      expect(selected).toBeTruthy();
      resolve(listing);
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
      expect(createSessionWorkspaceProps(state).activeId).toBe(selected);

      createSessionWorkspaceProps(state).onRefresh();
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
      expect(createSessionWorkspaceProps(state).activeId).toBe(selected);
      listFiles.mockResolvedValue({
        ...listing,
        browser: {
          path: "reports",
          entries: [{ kind: "file", name: "inventory.csv", path: "reports/inventory.csv" }],
        },
      });
      createSessionWorkspaceProps(state).onBrowsePath("reports");
      await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
      expect(createSessionWorkspaceProps(state).activeId).toBe(selected);
      expect(createSessionWorkspaceProps(state).list?.browser?.entries[0]?.path).toBe(
        "reports/inventory.csv",
      );
    },
  );
});
