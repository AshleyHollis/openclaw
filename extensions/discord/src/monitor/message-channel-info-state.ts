import type { DiscordChannelInfo } from "./message-channel-info-types.js";

export const discordChannelInfoCacheState = {
  entries: new Map<string, { value: DiscordChannelInfo | null; expiresAt: number }>(),
};
