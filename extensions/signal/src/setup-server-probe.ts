import type { WizardPrompter } from "openclaw/plugin-sdk/setup-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SignalApiMode } from "./client-adapter.js";

type SignalSetupServerProbeParams = {
  httpUrl: string;
  account: string;
  apiMode: SignalApiMode;
};

type SignalSetupServerProbeResult =
  | {
      ok: true;
      version?: string | null;
    }
  | {
      ok: false;
      error: string;
      accountRequired?: true;
    };

type SignalSetupServerProbe = (
  params: SignalSetupServerProbeParams,
) => Promise<SignalSetupServerProbeResult>;

let signalSetupServerProbeForTest: SignalSetupServerProbe | undefined;

async function defaultSignalSetupServerProbe(
  params: SignalSetupServerProbeParams,
): Promise<SignalSetupServerProbeResult> {
  const { probeSignal } = await import("./probe.js");
  const probe = await probeSignal(params.httpUrl, 5_000, {
    account: params.account,
    apiMode: params.apiMode,
  });
  if (probe.ok) {
    if (probe.error) {
      return {
        ok: false,
        error: probe.error,
      };
    }
    return { ok: true, version: probe.version };
  }
  return {
    ok: false,
    error: probe.error ?? `Signal server was not ready (${probe.readiness})`,
    ...(probe.readiness === "account_missing" ? { accountRequired: true as const } : {}),
  };
}

function resolveSignalSetupServerProbe(): SignalSetupServerProbe {
  return signalSetupServerProbeForTest ?? defaultSignalSetupServerProbe;
}

async function promptReachableSignalServerUrlImpl(params: {
  prompter: WizardPrompter;
  title: string;
  message: string;
  initialValue: string;
  placeholder: string;
  account: string;
  apiMode: SignalApiMode;
}): Promise<{ httpUrl: string; accountRequired?: true } | null> {
  while (true) {
    const httpUrl = normalizeOptionalString(
      await params.prompter.text({
        message: params.message,
        initialValue: params.initialValue,
        placeholder: params.placeholder,
        validate: (value) => (normalizeOptionalString(value) ? undefined : "Required"),
      }),
    );
    if (!httpUrl) {
      throw new Error("Signal server URL is required.");
    }

    const progress = params.prompter.progress("Testing Signal server URL");
    let probe: SignalSetupServerProbeResult | undefined;
    progress.update(`Testing ${httpUrl}`);
    try {
      probe = await resolveSignalSetupServerProbe()({
        httpUrl,
        account: params.account,
        apiMode: params.apiMode,
      });
    } catch (error) {
      progress.stop();
      await params.prompter.note(
        [
          `OpenClaw could not check the Signal server at ${httpUrl}.`,
          `Error: ${String(error)}`,
          "",
          "Start or fix the Signal helper, then try this URL again. OpenClaw will not save this setup until the server check passes.",
        ].join("\n"),
        params.title,
      );
    }
    if (probe?.ok) {
      progress.stop("Signal server reachable");
      return { httpUrl };
    }
    if (probe?.accountRequired) {
      progress.stop("Signal server reachable; account required");
      if (normalizeOptionalString(params.account)) {
        await params.prompter.note(
          [
            `The Signal server at ${httpUrl} does not provide the entered account.`,
            `Error: ${probe.error}`,
          ].join("\n"),
          params.title,
        );
        const retryAccount = await params.prompter.confirm({
          message: "Try a different Signal phone number?",
          initialValue: true,
        });
        if (!retryAccount) {
          return null;
        }
      }
      return { httpUrl, accountRequired: true };
    }
    if (probe) {
      progress.stop();
      await params.prompter.note(
        [
          `OpenClaw could not reach a working Signal server at ${httpUrl}.`,
          `Error: ${probe.error}`,
          "",
          "Start or fix the Signal helper, then try this URL again. OpenClaw will not save this setup until the server check passes.",
        ].join("\n"),
        params.title,
      );
    }

    const retry = await params.prompter.confirm({
      message: "Try the Signal server URL again?",
      initialValue: true,
    });
    if (!retry) {
      return null;
    }
    params.initialValue = httpUrl;
  }
}

export const promptReachableSignalServerUrl = Object.assign(promptReachableSignalServerUrlImpl, {
  setProbeForTest(probe: SignalSetupServerProbe | undefined): void {
    signalSetupServerProbeForTest = probe;
  },
});
