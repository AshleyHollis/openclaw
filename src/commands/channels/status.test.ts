// Channel status command tests cover gateway call identity and JSON fallback behavior.
process.env.NO_COLOR = "1";

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { channelsStatusCommand } from "./status.js";

const logs: string[] = [];
const errors: string[] = [];
const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(),
  listConfiguredAnnounceChannelIdsForConfig: vi.fn(),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  };
});

vi.mock("../../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommandConfigWithSecrets,
}));

vi.mock("../../plugins/channel-plugin-ids.js", () => ({
  listConfiguredAnnounceChannelIdsForConfig: mocks.listConfiguredAnnounceChannelIdsForConfig,
}));

const runtime = {
  log: (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  },
  error: (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  },
  exit: (code: number) => {
    throw new Error(`exit:${code}`);
  },
};

describe("channelsStatusCommand", () => {
  beforeEach(() => {
    logs.length = 0;
    errors.length = 0;
    vi.clearAllMocks();
    mocks.callGateway.mockResolvedValue({ channelAccounts: {}, channels: {} });
  });

  it("calls channels.status as a CLI gateway client", async () => {
    await channelsStatusCommand({ json: true }, runtime);

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "channels.status",
      params: { probe: false, timeoutMs: 10000 },
      timeoutMs: 10000,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
  });
});
