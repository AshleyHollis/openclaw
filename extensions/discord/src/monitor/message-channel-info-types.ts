import type { ChannelType } from "../internal/discord.js";

export type DiscordChannelInfo = {
  type: ChannelType;
  name?: string;
  topic?: string;
  parentId?: string;
  ownerId?: string;
};

export type DiscordChannelInfoClient = {
  fetchChannel(channelId: string): Promise<unknown>;
};
