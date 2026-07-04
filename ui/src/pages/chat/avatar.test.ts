import { describe, expect, it } from "vitest";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { resolveChatAvatarUrl } from "./avatar.ts";

describe("resolveChatAvatarUrl", () => {
  it("prefers the authenticated avatar blob over the protected route", () => {
    const state = {
      sessionKey: "agent:main:main",
      chatAvatarUrl: "blob:authenticated-avatar",
      assistantAvatar: "/avatar/main",
      assistantAgentId: "main",
    } as unknown as AppViewState;

    expect(resolveChatAvatarUrl(state)).toBe("blob:authenticated-avatar");
  });
});
