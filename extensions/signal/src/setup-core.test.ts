// Signal tests cover setup adapter integration with account-owned transport policy.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { signalSetupAdapter } from "./setup-core.js";

describe("signalSetupAdapter", () => {
  it("uses the setup transport allocator for a second managed account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: { work: { account: "+15555550124" } },
        },
      },
    };

    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "work",
      input: { cliPath: "/opt/signal-cli" },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "managed-native",
      cliPath: "/opt/signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8081,
    });
  });
});
