// Signal setup owns transport discovery and canonical account writes.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_ACCOUNT_ID,
  patchChannelConfigForAccount,
} from "openclaw/plugin-sdk/setup-runtime";
import type { SignalTransportConfig } from "./account-types.js";
import { listSignalAccountIds, resolveSignalAccount, resolveSignalTransport } from "./accounts.js";
import { containerCheck } from "./client-container.js";
import { signalCheck as nativeCheck } from "./client.js";
import { clearLegacySignalTransportFieldsForAccount } from "./config-compat.js";
import {
  allocateSignalManagedNativePort,
  DEFAULT_SIGNAL_MANAGED_NATIVE_HOST,
  resolveLocalSignalTransportPort,
} from "./transport-policy.js";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export type SignalManagedNativeTransport = Extract<
  SignalTransportConfig,
  { kind: "managed-native" }
>;

export type SignalTransportProbeResult = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
};

type NativeProbe = (url: string, timeoutMs?: number) => Promise<SignalTransportProbeResult>;
type ContainerProbe = (
  url: string,
  timeoutMs?: number,
  account?: string,
) => Promise<SignalTransportProbeResult>;

function normalizeTransportUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Signal transport URL is required");
  }
  const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Signal transport URL unsupported protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Signal transport URL must not include credentials");
  }
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function normalizeTransport(transport: SignalTransportConfig): SignalTransportConfig {
  if (transport.kind === "managed-native") {
    return transport;
  }
  return { ...transport, url: normalizeTransportUrl(transport.url) };
}

function configuredTransportForAccount(
  cfg: OpenClawConfig,
  accountId: string,
): SignalTransportConfig | undefined {
  const signal = cfg.channels?.signal;
  return accountId === DEFAULT_ACCOUNT_ID
    ? signal?.transport
    : signal?.accounts?.[accountId]?.transport;
}

export function prepareSignalManagedNativeTransport(params: {
  cfg: OpenClawConfig;
  accountId: string;
  overrides?: Omit<SignalManagedNativeTransport, "kind">;
}): SignalManagedNativeTransport {
  const existing = configuredTransportForAccount(params.cfg, params.accountId);
  const existingManaged = existing?.kind === "managed-native" ? existing : undefined;
  const preferredPort = params.overrides?.httpPort ?? existingManaged?.httpPort;
  const reservedPorts = new Set<number>();
  for (const accountId of listSignalAccountIds(params.cfg)) {
    if (accountId === params.accountId) {
      continue;
    }
    const account = resolveSignalAccount({ cfg: params.cfg, accountId });
    if (!account.configured) {
      continue;
    }
    if (account.transport.kind === "managed-native") {
      reservedPorts.add(account.transport.httpPort);
      continue;
    }
    const localPort = resolveLocalSignalTransportPort(account.transport.baseUrl);
    if (localPort !== undefined) {
      reservedPorts.add(localPort);
    }
  }

  const httpPort = allocateSignalManagedNativePort({ reservedPorts, preferredPort });
  return {
    kind: "managed-native",
    ...existingManaged,
    ...params.overrides,
    httpHost:
      params.overrides?.httpHost ?? existingManaged?.httpHost ?? DEFAULT_SIGNAL_MANAGED_NATIVE_HOST,
    httpPort,
  };
}

export async function detectSignalTransport(params: {
  url: string;
  account?: string;
  timeoutMs?: number;
  probeNative?: NativeProbe;
  probeContainer?: ContainerProbe;
}): Promise<SignalTransportConfig> {
  const url = normalizeTransportUrl(params.url);
  const timeoutMs = params.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probeNative = params.probeNative ?? nativeCheck;
  const probeContainer = params.probeContainer ?? containerCheck;
  const [native, container] = await Promise.all([
    probeNative(url, timeoutMs).catch(() => ({ ok: false })),
    probeContainer(url, timeoutMs, params.account).catch(() => ({ ok: false })),
  ]);
  if (native.ok) {
    return { kind: "external-native", url };
  }
  if (container.ok) {
    return { kind: "container", url };
  }
  throw new Error(`Signal transport not reachable at ${url}`);
}

export async function probeSignalTransport(params: {
  transport: SignalTransportConfig;
  account?: string;
  timeoutMs?: number;
  probeNative?: NativeProbe;
  probeContainer?: ContainerProbe;
}): Promise<SignalTransportProbeResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const resolved = resolveSignalTransport(params.transport);
  if (resolved.kind === "container") {
    return (params.probeContainer ?? containerCheck)(resolved.baseUrl, timeoutMs, params.account);
  }
  return (params.probeNative ?? nativeCheck)(resolved.baseUrl, timeoutMs);
}

export function writeSignalAccountTransport(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: SignalTransportConfig;
}): OpenClawConfig {
  const next = patchChannelConfigForAccount({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId,
    patch: { transport: normalizeTransport(params.transport) },
  });
  return clearLegacySignalTransportFieldsForAccount({
    cfg: next,
    accountId: params.accountId,
  });
}
