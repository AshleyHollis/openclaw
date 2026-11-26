import { assert, describe, expect, it, vi } from "vitest";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { createSessionWorkspaceHost } from "./chat-session-workspace-host.test-support.ts";
import { getChatSessionWorkspace, getSessionWorkspace } from "./chat-session-workspace-state.ts";
import { textFile } from "./chat-session-workspace.test-support.ts";
import {
  openSessionWorkspaceFileView,
  resolveSessionDiffSidebarContent,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";

function diffHost(request: unknown) {
  const state = createSessionWorkspaceHost({
    client: { request } as SessionWorkspaceHost["client"],
    hello: gatewayHelloForMethods(["sessions.diff"]),
  });
  const content = resolveSessionDiffSidebarContent(state);
  assert(content?.kind === "session-diff");
  return { state, content };
}

function editableHost(sessions: object) {
  return createSessionWorkspaceHost({
    sessions: sessions as SessionWorkspaceHost["sessions"],
    hello: gatewayHelloForMethods(["sessions.files.set"]),
  });
}

function noteResult() {
  return { sessionKey: "agent:main:files", file: textFile("notes.md", "before", { hash: "old" }) };
}

describe("independent Files conversation", () => {
  it("keeps native Chat diff requests and identity while Files changes its target", async () => {
    const request = vi.fn().mockResolvedValue({ files: [] });
    const { state, content } = diffHost(request);
    const original = getSessionWorkspace(state);
    const chatSessionKey = state.sessionKey;
    state.sidebarContent = content;
    state.sessionWorkspaceTarget = {
      sessionKey: "agent:fictional:files",
      agentId: "fictional",
      chatSessionKey,
      connectionEpoch: state.connectionEpoch,
    };
    const files = getSessionWorkspace(state);
    expect(files).not.toBe(original);
    expect(files).toMatchObject({ sessionKey: "agent:fictional:files", agentId: "fictional" });
    expect(resolveSessionDiffSidebarContent(state)).toBe(content);
    expect(state.sidebarContent).toBe(content);
    await content.load({ scope: "uncommitted" });
    expect(request).toHaveBeenLastCalledWith(
      "sessions.diff",
      expect.objectContaining({
        sessionKey: chatSessionKey,
        agentId: "main",
      }),
    );
    expect(getSessionWorkspace(state)).toBe(files);
  });

  it("reads Chat diff view/edit from its captured source while retaining Files' target", async () => {
    const getFile = vi.fn().mockResolvedValue(noteResult());
    const state = editableHost({ getFile });
    const chat = getChatSessionWorkspace(state);
    state.sessionWorkspaceTarget = {
      sessionKey: "agent:fictional:files",
      agentId: "fictional",
      chatSessionKey: state.sessionKey,
      connectionEpoch: state.connectionEpoch,
    };
    const files = getSessionWorkspace(state);
    await openSessionWorkspaceFileView(state, "notes.md", "edit", chat);
    expect(getFile).toHaveBeenCalledWith(state.sessionKey, "notes.md", { agentId: "main" });
    expect(getSessionWorkspace(state)).toBe(files);
    const preview = files.previews.find((entry) => entry.id === files.activePreviewId);
    expect(preview?.content).toMatchObject({ kind: "file", content: "before" });
    expect(preview?.navigation?.view).toEqual({ file: preview?.content, view: "edit" });
    state.sessionKey = "agent:main:replacement";
    getFile.mockClear();
    await openSessionWorkspaceFileView(state, "notes.md", "plain", chat);
    expect(getFile).not.toHaveBeenCalled();
  });

  it.each(["Chat", "connection"])("retires the Files target after its %s changes", (changed) => {
    const state = createSessionWorkspaceHost({ client: null, connected: false });
    state.sessionWorkspaceTarget = {
      sessionKey: "agent:fictional:files",
      agentId: "fictional",
      chatSessionKey: state.sessionKey,
      connectionEpoch: state.connectionEpoch,
    };
    const old = getSessionWorkspace(state);
    if (changed === "Chat") {
      state.sessionKey = "agent:main:replacement";
    } else {
      state.connectionEpoch += 1;
    }
    const current = getSessionWorkspace(state);
    expect(current).not.toBe(old);
    expect(current.sessionKey).toBe(state.sessionKey);
    expect(state.sessionWorkspaceTarget).toBeUndefined();
  });
});
