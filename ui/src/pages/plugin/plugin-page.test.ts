import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY_BRIDGE_BOOTSTRAP_SOURCE } from "../../../../src/gateway/control-ui-capability-bridge-bootstrap.js";
import { CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS } from "../../../../src/gateway/control-ui-plugin-frame-contract.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { EXTERNAL_TAB_BRIDGE_LIMITS } from "../../lib/external-tab-capability-bridge.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { getLogbookState, stopLogbookPolling } from "./logbook-controller.ts";
import { renderLogbook } from "./logbook-view.ts";
import { externalTabBridgeGrant, type ExternalTabBridgeGrant } from "./plugin-page.test-helpers.ts";
import { PluginPage } from "./plugin-page.ts";

type TestBundledView = {
  render: (props: Parameters<typeof renderLogbook>[0]) => unknown;
  stop: (host: object) => void;
};

type ApplicationConfig = ApplicationConfigCapability["current"];
const logbookBundledView = {
  render: renderLogbook,
  stop: stopLogbookPolling,
} satisfies TestBundledView;

function bundledViewHost(page: PluginPage): object {
  return (page as unknown as { bundledViewHost: object }).bundledViewHost;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class DeferredPluginPage extends PluginPage {
  loads = new Map<string, Promise<TestBundledView>[]>();

  protected override loadBundledView(key: string): Promise<TestBundledView> {
    const load = this.loads.get(key)?.shift();
    if (!load) {
      throw new Error(`Unexpected bundled view load: ${key}`);
    }
    return load;
  }
}

class ExternalPluginPage extends PluginPage {
  probeResults: Promise<boolean>[] = [Promise.resolve(true)];
  probeCalls: string[] = [];
  bridgeDocuments: Promise<string | null>[] = [Promise.resolve("<main>External panel</main>")];

  protected override probeExternalTabAuth(path: string, _signal: AbortSignal): Promise<boolean> {
    this.probeCalls.push(path);
    return this.probeResults.shift() ?? Promise.resolve(true);
  }

  protected override async loadCapabilityBridgeDocument(path: string, _signal: AbortSignal) {
    const markup = await (this.bridgeDocuments.shift() ??
      Promise.resolve("<main>External panel</main>"));
    return markup ? { source: new URL(path, window.location.href), markup } : null;
  }
}

const deferredPluginPageTag = "openclaw-deferred-plugin-page-test";
if (!customElements.get(deferredPluginPageTag)) {
  customElements.define(deferredPluginPageTag, DeferredPluginPage);
}

const externalPluginPageTag = "openclaw-external-plugin-page-test";
if (!customElements.get(externalPluginPageTag)) {
  customElements.define(externalPluginPageTag, ExternalPluginPage);
}

function createLogbookPage(): DeferredPluginPage {
  const page = document.createElement(deferredPluginPageTag) as DeferredPluginPage;
  // Import the real owner modules before test timing begins; this suite verifies
  // PluginPage lifecycle, not Vite's concurrent dynamic-transform latency.
  page.loads = new Map([["logbook/logbook", [Promise.resolve(logbookBundledView)]]]);
  page.pluginId = "logbook";
  page.tabId = "logbook";
  return page;
}

function externalPluginConfig(
  pluginFrameGrants: ApplicationConfig["pluginFrameGrants"] = [
    {
      pluginId: "external-plugin",
      path: "/plugins/external",
      match: "prefix",
    },
  ],
  embedSandboxMode: ApplicationConfig["embedSandboxMode"] = "scripts",
): ApplicationConfig {
  return {
    assistantIdentity: {
      agentId: null,
      name: "Assistant",
      avatar: null,
      avatarSource: null,
      avatarStatus: null,
      avatarReason: null,
    },
    serverVersion: null,
    devGitBranch: null,
    environment: null,
    localMediaPreviewRoots: [],
    embedSandboxMode,
    allowExternalEmbedUrls: false,
    automaticallyFetchFavicons: false,
    terminalEnabled: false,
    pluginFrameGrants,
  };
}

function createExternalPluginPage(
  refresh: ApplicationConfigCapability["refresh"],
  requiresGatewayAuth = true,
  path = "/plugins/external/panel",
  options: {
    auth?: GatewayHelloOk["auth"];
    capabilityBridge?: ExternalTabBridgeGrant;
    client?: GatewayBrowserClient | null;
    embedSandboxMode?: ApplicationConfig["embedSandboxMode"];
  } = {},
) {
  const hello: GatewayHelloOk = {
    type: "hello-ok",
    protocol: 3,
    auth: options.auth ?? {
      authorityId: "test-auth-authority",
      role: "operator",
      scopes: ["operator.write"],
    },
    controlUiTabs: [
      {
        pluginId: "external-plugin",
        id: "panel",
        label: "External panel",
        path,
        ...(options.capabilityBridge ? { capabilityBridge: options.capabilityBridge } : {}),
        ...(requiresGatewayAuth ? { requiresGatewayAuth: true } : {}),
      },
    ],
  };
  const snapshot: ApplicationGatewaySnapshot = {
    client: options.client ?? null,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const page = document.createElement(externalPluginPageTag) as ExternalPluginPage;
  page.pluginId = "external-plugin";
  page.tabId = "panel";
  (page as unknown as { context: ApplicationContext<RouteId> }).context = {
    gateway: {
      snapshot,
      subscribe: () => () => undefined,
    },
    config: {
      current: externalPluginConfig([], options.embedSandboxMode),
      refresh,
    },
  } as unknown as ApplicationContext<RouteId>;
  return page;
}

function bridgeClient(request = vi.fn()) {
  return {
    request,
    addEventListener: vi.fn(() => () => undefined),
    forceReconnect: vi.fn(),
  } as unknown as GatewayBrowserClient;
}

function bridgeState(page: PluginPage) {
  return page as unknown as {
    capabilityBridge: unknown;
    capabilityBridgeDocument: {
      key: string;
      markup: string;
      bootstrapId: string;
      mutationNamespace: string;
    } | null;
    capabilityBridgeFrameLoadSeen: boolean;
    handleCapabilityBridgeBootstrap: (event: MessageEvent) => void;
  };
}

function mountCapabilityBridge(page: PluginPage, frame: HTMLIFrameElement): MessagePort {
  const document = bridgeState(page).capabilityBridgeDocument;
  if (!document || !frame.contentWindow) {
    throw new Error("expected a provenance-bound bridge document");
  }
  const channel = new MessageChannel();
  bridgeState(page).handleCapabilityBridgeBootstrap({
    source: frame.contentWindow,
    data: { type: "openclaw:capability-bridge-bootstrap", id: document.bootstrapId },
    ports: [channel.port1],
  } as unknown as MessageEvent);
  if (!bridgeState(page).capabilityBridgeFrameLoadSeen) {
    frame.dispatchEvent(new Event("load"));
  }
  bridgeState(page).handleCapabilityBridgeBootstrap({
    source: frame.contentWindow,
    data: { type: "openclaw:capability-bridge-bootstrap-mounted", id: document.bootstrapId },
    ports: [],
  } as unknown as MessageEvent);
  channel.port2.start();
  return channel.port2;
}

describe("PluginPage", () => {
  beforeEach(() => {
    vi.stubGlobal("isSecureContext", true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes parent auth before mounting an external plugin frame", async () => {
    const pendingRefresh = deferred<ApplicationConfig | null>();
    const pendingProbe = deferred<boolean>();
    const refresh = vi.fn(() => pendingRefresh.promise);
    const page = createExternalPluginPage(refresh);
    page.probeResults = [pendingProbe.promise];
    document.body.append(page);
    try {
      await page.updateComplete;
      expect(refresh).toHaveBeenCalledOnce();
      expect(page.querySelector("iframe")).toBeNull();

      pendingRefresh.resolve(externalPluginConfig());
      await waitForFast(() => expect(page.probeCalls).toEqual(["/plugins/external/panel"]));
      expect(page.querySelector("iframe")).toBeNull();

      pendingProbe.resolve(true);
      await waitForFast(() =>
        expect(page.querySelector("iframe")?.getAttribute("src")).toBe("/plugins/external/panel"),
      );
    } finally {
      page.remove();
    }
  });

  it("keeps the frame unmounted when browser policy blocks the sandbox cookie", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh);
    page.probeResults = [Promise.resolve(false)];
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.textContent).toContain("Plugin panel unavailable"));
      expect(page.probeCalls).toEqual(["/plugins/external/panel"]);
      expect(page.querySelector("iframe")).toBeNull();
    } finally {
      page.remove();
    }
  });

  it("matches a route grant against tab URLs with query strings and fragments", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const path = "/plugins/external/panel?view=activity#settings";
    const page = createExternalPluginPage(refresh, true, path);
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.querySelector("iframe")?.getAttribute("src")).toBe(path));
      expect(page.probeCalls).toEqual([path]);
    } finally {
      page.remove();
    }
  });

  it("keeps authenticated bridge frames origin-opaque even in trusted embed mode", async () => {
    const refresh = vi.fn(async () => externalPluginConfig(undefined, "trusted"));
    const client = bridgeClient();
    const page = createExternalPluginPage(refresh, true, "/plugins/external/panel", {
      capabilityBridge: externalTabBridgeGrant(),
      client,
      embedSandboxMode: "trusted",
    });
    document.body.append(page);
    try {
      await waitForFast(() =>
        expect(page.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<main>"),
      );
      const frame = page.querySelector("iframe");
      expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
      expect(frame?.getAttribute("src")).toBeNull();
    } finally {
      page.remove();
    }
  });

  it("keeps mount provenance out of the CSP-authorized bootstrap body", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh, true, "/plugins/external/panel", {
      capabilityBridge: externalTabBridgeGrant(),
      client: bridgeClient(),
    });
    document.body.append(page);
    try {
      await waitForFast(() =>
        expect(page.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<main>"),
      );
      const bridgeDocument = bridgeState(page).capabilityBridgeDocument;
      if (!bridgeDocument) {
        throw new Error("expected bridge document");
      }
      const script = bridgeDocument.markup.match(/<script ([^>]*)>([^]*?)<\/script>/);
      expect(script?.[1]).toBe(
        `data-openclaw-capability-bridge-bootstrap-id="${bridgeDocument.bootstrapId}"`,
      );
      expect(script?.[2]).toBe(CAPABILITY_BRIDGE_BOOTSTRAP_SOURCE);
      expect(script?.[2]).not.toContain(bridgeDocument.bootstrapId);
    } finally {
      page.remove();
    }
  });

  it("keeps an incompatible bridge declaration on the authenticated read-only frame", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.querySelector("iframe")).not.toBeNull());
      expect(page.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(page.textContent).toContain("Capability bridge unavailable");
    } finally {
      page.remove();
    }
  });

  it("keeps a bridge declaration on the authenticated read-only route without an authority marker", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh, true, "/plugins/external/panel", {
      auth: { role: "operator", scopes: ["operator.write"] },
      capabilityBridge: externalTabBridgeGrant(),
      client: bridgeClient(),
    });
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.querySelector("iframe")).not.toBeNull());
      expect(page.querySelector("iframe")?.getAttribute("src")).toBe("/plugins/external/panel");
      expect(page.querySelector("iframe")?.getAttribute("srcdoc")).toBeNull();
      expect(page.textContent).toContain("Capability bridge unavailable");
    } finally {
      page.remove();
    }
  });

  it("grants one validated iframe mount and terminally revokes later loads", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const client = bridgeClient();
    const page = createExternalPluginPage(refresh, true, "/plugins/external/panel", {
      capabilityBridge: externalTabBridgeGrant(),
      client,
    });
    document.body.append(page);
    try {
      await waitForFast(() =>
        expect(page.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<main>"),
      );
      const frame = page.querySelector("iframe");
      if (!frame) {
        throw new Error("expected plugin frame");
      }
      mountCapabilityBridge(page, frame);
      const bridge = bridgeState(page);
      expect(bridge.capabilityBridge).not.toBeNull();

      frame.dispatchEvent(new Event("load"));
      expect(bridge.capabilityBridge).toBeNull();
    } finally {
      page.remove();
    }
  });

  it("does not accept a bootstrap for a source document whose mount changed", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const request = vi.fn();
    const client = bridgeClient(request);
    const page = createExternalPluginPage(refresh, true, "/plugins/external/panel", {
      capabilityBridge: externalTabBridgeGrant(),
      client,
    });
    document.body.append(page);
    try {
      await waitForFast(() =>
        expect(page.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<main>"),
      );
      const frame = page.querySelector("iframe");
      if (!frame?.contentWindow) {
        throw new Error("expected plugin frame");
      }
      const document = bridgeState(page).capabilityBridgeDocument;
      if (!document) {
        throw new Error("expected bridge document");
      }
      const channel = new MessageChannel();
      frame.setAttribute("srcdoc", "<main>redirected</main>");
      bridgeState(page).handleCapabilityBridgeBootstrap({
        source: frame.contentWindow,
        data: { type: "openclaw:capability-bridge-bootstrap", id: document.bootstrapId },
        ports: [channel.port1],
      } as unknown as MessageEvent);
      expect(bridgeState(page).capabilityBridge).toBeNull();
      expect(request).not.toHaveBeenCalled();
    } finally {
      page.remove();
    }
  });

  it("falls back to the authenticated read-only route after an incompatible bridge handshake", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const client = bridgeClient();
    const page = createExternalPluginPage(refresh, true, "/plugins/external/panel", {
      capabilityBridge: externalTabBridgeGrant(),
      client,
    });
    document.body.append(page);
    try {
      await waitForFast(() =>
        expect(page.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<main>"),
      );
      const frame = page.querySelector("iframe");
      if (!frame) {
        throw new Error("expected plugin frame");
      }
      const port = mountCapabilityBridge(page, frame);
      expect(bridgeState(page).capabilityBridge).not.toBeNull();
      port.postMessage({ type: "openclaw:capability-bridge-hello", protocolVersion: 2 });
      await waitForFast(() => {
        expect(bridgeState(page).capabilityBridge).toBeNull();
        expect(page.querySelector("iframe")?.getAttribute("src")).toBe("/plugins/external/panel");
        expect(page.querySelector("iframe")?.getAttribute("srcdoc")).toBeNull();
        expect(page.textContent).toContain("Capability bridge unavailable");
      });
    } finally {
      page.remove();
    }
  });

  it("falls back to the authenticated read-only route when the bridge hello is absent", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const client = bridgeClient();
    const page = createExternalPluginPage(refresh, true, "/plugins/external/panel", {
      capabilityBridge: externalTabBridgeGrant(),
      client,
    });
    document.body.append(page);
    try {
      await waitForFast(() =>
        expect(page.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<main>"),
      );
      const frame = page.querySelector("iframe");
      if (!frame) {
        throw new Error("expected plugin frame");
      }
      vi.useFakeTimers();
      mountCapabilityBridge(page, frame);
      await vi.advanceTimersByTimeAsync(EXTERNAL_TAB_BRIDGE_LIMITS.handshakeTimeoutMs);
      await page.updateComplete;

      expect(bridgeState(page).capabilityBridge).toBeNull();
      expect(page.querySelector("iframe")?.getAttribute("src")).toBe("/plugins/external/panel");
      expect(page.querySelector("iframe")?.getAttribute("srcdoc")).toBeNull();
      expect(page.textContent).toContain("Capability bridge unavailable");
    } finally {
      page.remove();
      vi.useRealTimers();
    }
  });

  it("keeps tokenless mutation identity through a reconnect but rotates it for a new auth authority", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const client = bridgeClient();
    const page = createExternalPluginPage(refresh, true, "/plugins/external/panel", {
      capabilityBridge: externalTabBridgeGrant(),
      client,
    });
    const context = (page as unknown as { context: ApplicationContext<RouteId> }).context;
    context.gateway.snapshot.hello!.server = { connId: "connection-one" };
    context.gateway.snapshot.hello!.auth = {
      authorityId: "token-auth-generation-one",
      role: "operator",
      scopes: ["operator.write"],
    };
    document.body.append(page);
    try {
      await waitForFast(() =>
        expect(page.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<main>"),
      );
      const first = bridgeState(page).capabilityBridgeDocument;
      if (!first) {
        throw new Error("expected first bridge document");
      }

      const firstHello = context.gateway.snapshot.hello!;
      context.gateway.snapshot.phase = "reconnecting";
      context.gateway.snapshot.hello = null;
      page.requestUpdate();
      await page.updateComplete;

      context.gateway.snapshot.phase = "connected";
      context.gateway.snapshot.hello = {
        ...firstHello,
        server: { connId: "connection-two" },
      };
      page.requestUpdate();
      await waitForFast(() => {
        const next = bridgeState(page).capabilityBridgeDocument;
        expect(next?.key).not.toBe(first.key);
        expect(next?.mutationNamespace).toBe(first.mutationNamespace);
      });

      context.gateway.snapshot.hello!.auth = {
        authorityId: "token-auth-generation-two",
        role: "operator",
        scopes: ["operator.write"],
      };
      page.requestUpdate();
      await waitForFast(() => {
        const next = bridgeState(page).capabilityBridgeDocument;
        expect(next?.mutationNamespace).not.toBe(first.mutationNamespace);
      });
    } finally {
      page.remove();
    }
  });

  it("revokes an active bridge before reconnecting after a plugin runtime reload", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    let emitGatewayEvent: ((event: { event: string }) => void) | undefined;
    const forceReconnect = vi.fn();
    const client = {
      request: vi.fn(),
      addEventListener: vi.fn((listener) => {
        emitGatewayEvent = listener as (event: { event: string }) => void;
        return () => undefined;
      }),
      forceReconnect,
    } as unknown as GatewayBrowserClient;
    const page = createExternalPluginPage(refresh, true, "/plugins/external/panel", {
      capabilityBridge: externalTabBridgeGrant(),
      client,
    });
    document.body.append(page);
    try {
      await waitForFast(() =>
        expect(page.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<main>"),
      );
      const frame = page.querySelector("iframe");
      if (!frame) {
        throw new Error("expected plugin frame");
      }
      mountCapabilityBridge(page, frame);
      expect(bridgeState(page).capabilityBridge).not.toBeNull();
      emitGatewayEvent?.({ event: "config.changed" });
      expect(bridgeState(page).capabilityBridge).toBeNull();
      expect(forceReconnect).toHaveBeenCalledWith("plugin runtime changed");
    } finally {
      page.remove();
    }
  });

  it("reconnects during auth probing before a stale bridge grant can mount", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const probe = deferred<boolean>();
    let emitGatewayEvent: ((event: { event: string }) => void) | undefined;
    const forceReconnect = vi.fn();
    const client = {
      request: vi.fn(),
      addEventListener: vi.fn((listener) => {
        emitGatewayEvent = listener as (event: { event: string }) => void;
        return () => undefined;
      }),
      forceReconnect,
    } as unknown as GatewayBrowserClient;
    const page = createExternalPluginPage(refresh, true, "/plugins/external/panel", {
      capabilityBridge: externalTabBridgeGrant(),
      client,
    });
    page.probeResults = [probe.promise];
    document.body.append(page);
    try {
      await waitForFast(() => {
        expect(page.probeCalls).toEqual(["/plugins/external/panel"]);
        expect(emitGatewayEvent).toBeTypeOf("function");
      });
      expect(page.querySelector("iframe")).toBeNull();

      emitGatewayEvent?.({ event: "config.changed" });
      expect(forceReconnect).toHaveBeenCalledWith("plugin runtime changed");

      probe.resolve(true);
      await waitForFast(() =>
        expect(page.querySelector("iframe")?.getAttribute("src")).toBe("/plugins/external/panel"),
      );
      expect(page.querySelector("iframe")?.getAttribute("srcdoc")).toBeNull();
    } finally {
      page.remove();
    }
  });

  it("marks the panel unavailable when bootstrap issued no matching grant", async () => {
    const refresh = vi.fn(async () => externalPluginConfig([]));
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.textContent).toContain("Plugin panel unavailable"));
      expect(page.querySelector("iframe")).toBeNull();
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      page.remove();
    }
  });

  it("renews external plugin auth before the route-bound grant expires", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await page.updateComplete;
      await Promise.resolve();
      await page.updateComplete;
      expect(refresh).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
      expect(refresh).toHaveBeenCalledTimes(2);

      page.remove();
      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      page.remove();
      vi.useRealTimers();
    }
  });

  it("unmounts an external frame when renewal hangs past grant expiry", async () => {
    vi.useFakeTimers();
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    const refresh = vi
      .fn<ApplicationConfigCapability["refresh"]>()
      .mockResolvedValueOnce(externalPluginConfig())
      .mockImplementation(
        (options) =>
          new Promise<ApplicationConfig | null>((resolve) => {
            activeRefreshes += 1;
            maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
            options?.signal?.addEventListener(
              "abort",
              () => {
                activeRefreshes -= 1;
                resolve(null);
              },
              { once: true },
            );
          }),
      );
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await page.updateComplete;
      await Promise.resolve();
      await page.updateComplete;
      await Promise.resolve();
      await page.updateComplete;
      expect(page.querySelector("iframe")).not.toBeNull();

      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(page.querySelector("iframe")).not.toBeNull();

      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
      await page.updateComplete;
      expect(page.querySelector("iframe")).toBeNull();
      expect(refresh.mock.calls.length).toBeGreaterThan(2);
      expect(maxActiveRefreshes).toBe(1);
    } finally {
      page.remove();
      vi.useRealTimers();
    }
  });

  it("serially replaces a hung renewal when an expired page resumes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    const refresh = vi
      .fn<ApplicationConfigCapability["refresh"]>()
      .mockResolvedValueOnce(externalPluginConfig())
      .mockImplementation(
        (options) =>
          new Promise<ApplicationConfig | null>((resolve) => {
            activeRefreshes += 1;
            maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
            options?.signal?.addEventListener(
              "abort",
              () => {
                activeRefreshes -= 1;
                resolve(null);
              },
              { once: true },
            );
          }),
      );
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await page.updateComplete;
      await Promise.resolve();
      await page.updateComplete;
      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
      expect(refresh).toHaveBeenCalledTimes(2);

      vi.setSystemTime(new Date(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS));
      (
        page as unknown as {
          handleVisibilityChange: () => void;
        }
      ).handleVisibilityChange();
      await Promise.resolve();
      await page.updateComplete;

      expect(page.querySelector("iframe")).toBeNull();
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(maxActiveRefreshes).toBe(1);
    } finally {
      page.remove();
      vi.useRealTimers();
    }
  });

  it("refreshes the frame grant after gateway reconnect", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.querySelector("iframe")).not.toBeNull());
      const context = (page as unknown as { context: ApplicationContext<RouteId> }).context;
      const gateway = context.gateway;
      const snapshot = gateway.snapshot;

      snapshot.phase = "stopped";
      (
        page as unknown as {
          updateGatewaySource: (source: ApplicationContext<RouteId>["gateway"]) => void;
        }
      ).updateGatewaySource(gateway);
      await page.updateComplete;
      expect(page.querySelector("iframe")).toBeNull();

      snapshot.phase = "connected";
      (
        page as unknown as {
          updateGatewaySource: (source: ApplicationContext<RouteId>["gateway"]) => void;
        }
      ).updateGatewaySource(gateway);
      await waitForFast(() => expect(page.querySelector("iframe")).not.toBeNull());
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      page.remove();
    }
  });

  it("refuses external plugin auth outside a secure browser context", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh);
    (
      page as unknown as {
        isExternalTabAuthSupported: () => boolean;
      }
    ).isExternalTabAuthSupported = () => false;
    document.body.append(page);
    try {
      await page.updateComplete;
      expect(refresh).not.toHaveBeenCalled();
      expect(page.querySelector("iframe")).toBeNull();
      expect(page.textContent).toContain("Secure browser context required");
    } finally {
      page.remove();
    }
  });

  it("keeps plugin-auth external panels available outside a secure context", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh, false);
    (
      page as unknown as {
        isExternalTabAuthSupported: () => boolean;
      }
    ).isExternalTabAuthSupported = () => false;
    document.body.append(page);
    try {
      await page.updateComplete;
      expect(refresh).not.toHaveBeenCalled();
      expect(page.querySelector("iframe")?.getAttribute("src")).toBe("/plugins/external/panel");
    } finally {
      page.remove();
    }
  });

  it("stops a bundled view when its advertised descriptor disappears", async () => {
    const bundledView = deferred<TestBundledView>();
    const stop = vi.fn();
    const hello: GatewayHelloOk = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.write"] },
      controlUiTabs: [{ pluginId: "logbook", id: "logbook", label: "Logbook" }],
    };
    const snapshot: ApplicationGatewaySnapshot = {
      client: null,
      phase: "connected",
      offlineStable: false,
      canvasPluginSurfaceUrl: null,
      hello,
      assistantAgentId: null,
      sessionKey: "main",
      lastError: null,
      lastErrorCode: null,
    };
    const page = document.createElement(deferredPluginPageTag) as DeferredPluginPage;
    page.loads = new Map([["logbook/logbook", [bundledView.promise]]]);
    page.pluginId = "logbook";
    page.tabId = "logbook";
    (page as unknown as { context: ApplicationContext<RouteId> }).context = {
      gateway: { snapshot, subscribe: () => () => undefined },
    } as unknown as ApplicationContext<RouteId>;

    document.body.append(page);
    try {
      bundledView.resolve({ render: () => "Logbook view", stop });
      await waitForFast(() => expect(page.textContent).toContain("Logbook view"));
      const previousHost = bundledViewHost(page);

      hello.controlUiTabs = [];
      page.requestUpdate();
      await page.updateComplete;

      expect(bundledViewHost(page)).not.toBe(previousHost);
      expect(stop).toHaveBeenCalledWith(previousHost);
    } finally {
      page.remove();
    }
  });

  it("drops bundled view state and reloads immediately when the gateway source changes", async () => {
    const hello: GatewayHelloOk = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.write"] },
      controlUiTabs: [{ pluginId: "logbook", id: "logbook", label: "Logbook" }],
    };
    const responseFor = (method: string) => {
      if (method === "logbook.status") {
        return {
          captureEnabled: true,
          capturePaused: false,
          captureIntervalSeconds: 30,
          analysisIntervalMinutes: 15,
          retentionDays: 30,
          pendingFrames: 0,
          analysisRunning: false,
          visionModelSource: "missing",
          today: "2026-07-05",
          todayCards: 0,
          timeZone: "UTC",
        };
      }
      if (method === "logbook.days") {
        return { days: [] };
      }
      return {
        day: "2026-07-05",
        cards: [],
        stats: { trackedMs: 0, distractionMs: 0, categories: [], apps: [] },
      };
    };
    const firstRequest = vi.fn(async (method: string) => responseFor(method));
    const secondRequest = vi.fn(async (method: string) => responseFor(method));
    const createContext = (request: typeof firstRequest) => {
      const snapshot: ApplicationGatewaySnapshot = {
        client: {
          request,
          addEventListener: () => () => undefined,
          forceReconnect: () => undefined,
        } as unknown as GatewayBrowserClient,
        phase: "connected",
        offlineStable: false,
        canvasPluginSurfaceUrl: null,
        hello,
        assistantAgentId: null,
        sessionKey: "main",
        lastError: null,
        lastErrorCode: null,
      };
      return {
        gateway: { snapshot, subscribe: () => () => undefined },
      } as unknown as ApplicationContext<RouteId>;
    };
    const page = createLogbookPage();
    (page as unknown as { context: ApplicationContext<RouteId> }).context =
      createContext(firstRequest);
    document.body.append(page);
    try {
      await waitForFast(() => expect(firstRequest).toHaveBeenCalled());
      const firstHost = bundledViewHost(page);
      expect(getLogbookState(firstHost).pollTimer).not.toBeNull();

      (page as unknown as { context: ApplicationContext<RouteId> }).context =
        createContext(secondRequest);
      page.requestUpdate();
      await page.updateComplete;

      await waitForFast(() => expect(secondRequest).toHaveBeenCalledWith("logbook.status", {}));
      expect(bundledViewHost(page)).not.toBe(firstHost);
      expect(getLogbookState(firstHost).pollTimer).toBeNull();
    } finally {
      page.remove();
    }
  });

  it("isolates an in-flight bundled load across a same-client reconnect", async () => {
    const hello: GatewayHelloOk = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.write"] },
      controlUiTabs: [{ pluginId: "logbook", id: "logbook", label: "Logbook" }],
    };
    const staleStatus = deferred<unknown>();
    const staleDays = deferred<unknown>();
    const staleTimeline = deferred<unknown>();
    const pending = new Map([
      ["logbook.status", staleStatus],
      ["logbook.days", staleDays],
      ["logbook.timeline", staleTimeline],
    ]);
    const responseFor = (method: string) => {
      if (method === "logbook.status") {
        return {
          captureEnabled: true,
          capturePaused: false,
          captureIntervalSeconds: 30,
          analysisIntervalMinutes: 15,
          retentionDays: 30,
          pendingFrames: 0,
          analysisRunning: false,
          visionModelSource: "missing",
          today: "2026-07-05",
          todayCards: 0,
          timeZone: "UTC",
        };
      }
      if (method === "logbook.days") {
        return { days: [] };
      }
      return {
        day: "2026-07-05",
        cards: [],
        stats: { trackedMs: 0, distractionMs: 0, categories: [], apps: [] },
      };
    };
    const request = vi.fn((method: string) => {
      const deferredResponse = pending.get(method);
      return deferredResponse ? deferredResponse.promise : Promise.resolve(responseFor(method));
    });
    const client = {
      request,
      addEventListener: () => () => undefined,
      forceReconnect: () => undefined,
    } as unknown as GatewayBrowserClient;
    const snapshot: ApplicationGatewaySnapshot = {
      client,
      phase: "connected",
      offlineStable: false,
      canvasPluginSurfaceUrl: null,
      hello,
      assistantAgentId: null,
      sessionKey: "main",
      lastError: null,
      lastErrorCode: null,
    };
    let listener: ((snapshot: ApplicationGatewaySnapshot) => void) | undefined;
    const gateway = {
      snapshot,
      subscribe(next: (snapshot: ApplicationGatewaySnapshot) => void) {
        listener = next;
        return () => {
          if (listener === next) {
            listener = undefined;
          }
        };
      },
    } as unknown as ApplicationContext<RouteId>["gateway"];
    const page = createLogbookPage();
    (page as unknown as { context: ApplicationContext<RouteId> }).context = {
      gateway,
    } as unknown as ApplicationContext<RouteId>;
    document.body.append(page);
    try {
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
      const staleHost = bundledViewHost(page);

      snapshot.phase = "stopped";
      listener?.(snapshot);
      await page.updateComplete;
      const disconnectedHost = bundledViewHost(page);
      expect(disconnectedHost).not.toBe(staleHost);

      pending.clear();
      staleStatus.resolve(responseFor("logbook.status"));
      staleDays.resolve(responseFor("logbook.days"));
      staleTimeline.resolve(responseFor("logbook.timeline"));
      await waitForFast(() => expect(getLogbookState(staleHost).timeline).not.toBeNull());
      expect(getLogbookState(disconnectedHost).timeline).toBeNull();

      snapshot.phase = "connected";
      listener?.(snapshot);
      await page.updateComplete;
      expect(bundledViewHost(page)).not.toBe(disconnectedHost);
      await waitForFast(() => expect(getLogbookState(bundledViewHost(page)).status).not.toBeNull());
    } finally {
      page.remove();
    }
  });

  it("does not install an earlier bundled view after switching away and back", async () => {
    const firstLogbookLoad = deferred<TestBundledView>();
    const currentLogbookLoad = deferred<TestBundledView>();
    const hello: GatewayHelloOk = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.write"] },
      controlUiTabs: [
        { pluginId: "logbook", id: "logbook", label: "Logbook" },
        {
          pluginId: "external-plugin",
          id: "panel",
          label: "External panel",
        },
      ],
    };
    const snapshot: ApplicationGatewaySnapshot = {
      client: null,
      phase: "connected",
      offlineStable: false,
      canvasPluginSurfaceUrl: null,
      hello,
      assistantAgentId: null,
      sessionKey: "main",
      lastError: null,
      lastErrorCode: null,
    };
    const page = document.createElement(deferredPluginPageTag) as DeferredPluginPage;
    page.loads = new Map([
      ["logbook/logbook", [firstLogbookLoad.promise, currentLogbookLoad.promise]],
    ]);
    page.pluginId = "logbook";
    page.tabId = "logbook";
    (page as unknown as { context: ApplicationContext<RouteId> }).context = {
      gateway: { snapshot, subscribe: () => () => undefined },
    } as unknown as ApplicationContext<RouteId>;

    document.body.append(page);
    try {
      await page.updateComplete;
      page.pluginId = "external-plugin";
      page.tabId = "panel";
      await page.updateComplete;
      page.pluginId = "logbook";
      page.tabId = "logbook";
      await page.updateComplete;

      currentLogbookLoad.resolve({ render: () => "current Logbook view", stop: vi.fn() });
      await waitForFast(() => expect(page.textContent).toContain("current Logbook view"));

      firstLogbookLoad.resolve({ render: () => "stale Logbook view", stop: vi.fn() });
      await Promise.resolve();
      await page.updateComplete;
      expect(page.textContent).not.toContain("stale Logbook view");
      expect(page.textContent).toContain("current Logbook view");
    } finally {
      page.remove();
    }
  });
});
