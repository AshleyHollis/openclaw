// Signal plugin module implements account types behavior.
import type { OpenClawConfig, SignalTransportConfig } from "openclaw/plugin-sdk/config-contracts";

export type SignalAccountConfig = Omit<
  Exclude<NonNullable<OpenClawConfig["channels"]>["signal"], undefined>,
  "accounts" | "defaultAccount"
>;

export type { SignalTransportConfig };
