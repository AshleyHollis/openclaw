import { resolveChatAgentId } from "../../ui/app-render.helpers.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { loadLocalAssistantIdentity } from "../../ui/storage.ts";
import { isRenderableControlUiAvatarUrl } from "../../ui/views/agents-utils.ts";

export { resolveChatAgentId };

export function resolveChatAvatarUrl(state: AppViewState): string | null {
  const agentId = resolveChatAgentId(state);
  const localAvatar = loadLocalAssistantIdentity({ agentId }).avatar;
  if (localAvatar) {
    return localAvatar;
  }
  const avatarMissing =
    (state.chatAvatarStatus ?? state.assistantAvatarStatus) === "none" &&
    (state.chatAvatarReason ?? state.assistantAvatarReason) === "missing";
  if (state.chatAvatarUrl) {
    return state.chatAvatarUrl;
  }
  if (
    !avatarMissing &&
    state.assistantAvatar &&
    state.assistantAgentId === agentId &&
    isRenderableControlUiAvatarUrl(state.assistantAvatar)
  ) {
    return state.assistantAvatar;
  }
  const identity = state.agentsList?.agents?.find((agent) => agent.id === agentId)?.identity;
  const avatar = identity?.avatarUrl ?? identity?.avatar;
  return typeof avatar === "string" && isRenderableControlUiAvatarUrl(avatar) ? avatar : null;
}
