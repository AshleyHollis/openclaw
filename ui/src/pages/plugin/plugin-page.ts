import { consume } from "@lit/context";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { ControlUiPluginFrameGrantAck } from "../../../../src/gateway/control-ui-bootstrap-contract.js";
import { keyed } from "lit/directives/keyed.js";
import {
  CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS,
  CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE,
  CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY,
  CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY,
  resolveControlUiPluginTabPathname,
} from "../../../../src/gateway/control-ui-plugin-frame-contract.js";
import type { GatewayBrowserClient, GatewayControlUiPluginTab } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorApprovalsAccess } from "../../app/operator-access.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "../../app/stale-chunk-reload.ts";
import { renderLazyViewError } from "../../components/lazy-view-error.ts";
import { renderLoadingState } from "../../components/loading-state.ts";
import { t } from "../../i18n/index.ts";
import { resolveEmbedSandbox } from "../../lib/chat/tool-display.ts";
import {
  createExternalTabCapabilityBridgeMutationState,
  EXTERNAL_TAB_BRIDGE_MAX_MUTATION_OPERATIONS,
  EXTERNAL_TAB_BRIDGE_LIMITS,
  ExternalTabCapabilityBridgeController,
  type ExternalTabCapabilityBridgeMutationState,
} from "../../lib/external-tab-capability-bridge.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { OpenClawLightDomContentsElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { pluginTabKey, type PluginNotificationNavigation } from "./route.ts";

/**
 * Bundled plugin tab views ship with the Control UI and render natively; every
 * other tab either embeds the plugin-served panel (descriptor path) in a
 * sandboxed frame or shows the unavailable card.
 */
type BundledPluginTabView = {
  render: (props: {
    host: object;
    client: GatewayBrowserClient | null;
    connected: boolean;
    embed?: {
      embedSandboxMode: ApplicationContext<RouteId>["config"]["current"]["embedSandboxMode"];
      allowExternalEmbedUrls: boolean;
    };
    onRequestUpdate: () => void;
    // L5: custom widgets need the gateway HTTP base (iframe src) and the session
    // key (prompt dispatch). Bundled views that don't use them ignore these.
    basePath?: string;
    sessionKey?: string;
    /** Canonical sessions.list publication revision, used by session-backed widgets. */
    sessionListRevision?: number;
    /** Whether this connection can decide pending custom-widget code. */
    canApproveWidgets?: boolean;
  }) => unknown;
  stop: (host: object) => void;
};

type BundledPluginTabViewState =
  | { status: "idle" }
  | { status: "loading"; id: string; token: object }
  | { status: "error"; id: string; error: unknown }
  | { status: "ready"; id: string; view: BundledPluginTabView };

function pluginFrameGrantCoversTab(
  grant: ControlUiPluginFrameGrantAck,
  info: GatewayControlUiPluginTab,
): boolean {
  if (!info.path || grant.pluginId !== info.pluginId) {
    return false;
  }
  const tabPath = resolveControlUiPluginTabPathname(info.path);
  if (!tabPath) {
    return false;
  }
  if (grant.match === "exact") {
    return tabPath === grant.path;
  }
  return (
    tabPath === grant.path ||
    (tabPath.startsWith(grant.path) &&
      (grant.path.endsWith("/") || tabPath.at(grant.path.length) === "/"))
  );
}

function isSameOriginFramePath(path: string): boolean {
  try {
    return new URL(path, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

const EXTERNAL_AUTH_REFRESH_TIMEOUT_MS = 10_000;
const EXTERNAL_AUTH_PROBE_TIMEOUT_MS = 5_000;
const AUTHENTICATED_EXTERNAL_TAB_SANDBOX = "allow-scripts";
const MAX_CAPABILITY_BRIDGE_DOCUMENT_BYTES = 1024 * 1024;
const CAPABILITY_BRIDGE_BOOTSTRAP_MESSAGE = "openclaw:capability-bridge-bootstrap";
const CAPABILITY_BRIDGE_BOOTSTRAP_MOUNTED_MESSAGE = "openclaw:capability-bridge-bootstrap-mounted";
const CAPABILITY_BRIDGE_MUTATION_TOMBSTONES_STORAGE_PREFIX =
  "openclaw.capability-bridge.tombstones.v1.";

function randomBridgeBootstrapId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/**
 * The bootstrap holds the iframe side of the port. Its public, versioned
 * window relay lets the plugin speak the bridge without transferring the port
 * into a document that could have navigated after provenance was checked.
 */
function buildCapabilityBridgeDocument(source: URL, markup: string, bootstrapId: string): string {
  const base = `<base href="${escapeHtmlAttribute(source.href)}">`;
  const bootstrap = [
    "<script>(()=>{",
    `const id=${JSON.stringify(bootstrapId)};`,
    "const channel=new MessageChannel();const port=channel.port1;",
    'port.onmessage=(event)=>window.postMessage({type:"openclaw:capability-bridge-receive",protocolVersion:1,payload:event.data},"*");',
    "port.start();",
    'window.addEventListener("message",(event)=>{const data=event.data;if(event.source===window&&data?.type==="openclaw:capability-bridge-send"&&data.protocolVersion===1)port.postMessage(data.payload)});',
    `window.addEventListener("load",()=>parent.postMessage({type:"${CAPABILITY_BRIDGE_BOOTSTRAP_MOUNTED_MESSAGE}",id},"*"),{once:true});`,
    "document.currentScript?.remove();",
    `parent.postMessage({type:"${CAPABILITY_BRIDGE_BOOTSTRAP_MESSAGE}",id},"*",[channel.port2]);`,
    "})()</script>",
  ].join("");
  // Prefixing rather than locating a <head> means a malformed document cannot
  // run a redirecting script before the bootstrap owns its channel endpoint.
  return `<!doctype html><head>${bootstrap}${base}</head>${markup}`;
}

// Keyed by pluginId/tabId: tab ids are only unique within their plugin.
const BUNDLED_TAB_VIEWS: Record<string, () => Promise<BundledPluginTabView>> = {
  "logbook/logbook": async () => {
    const [{ renderLogbook }, { stopLogbookPolling }] = await Promise.all([
      import("./logbook-view.ts"),
      import("./logbook-controller.ts"),
    ]);
    return { render: renderLogbook, stop: stopLogbookPolling };
  },
};

export class PluginPage extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) pluginId = "";
  @property({ attribute: false }) tabId = "";
  @property({ attribute: false }) notificationTarget: PluginNotificationNavigation | undefined;

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext<RouteId>;

  @state() private bundledViewState: BundledPluginTabViewState = { status: "idle" };
  @state() private externalAuthReadyKey: string | null = null;
  @state() private externalAuthUnavailableKey: string | null = null;
  @state()
  private capabilityBridgeDocument: {
    key: string;
    markup: string;
    bootstrapId: string;
    mutationNamespace: string;
  } | null = null;

  private bundledViewHost: object = {};
  private gatewaySource?: ApplicationContext<RouteId>["gateway"];
  private gatewayClient: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  private externalAuthTargetKey: string | null = null;
  private externalAuthRefreshMarker: object | null = null;
  private externalAuthRefreshAbortController: AbortController | null = null;
  private externalAuthRefreshWatchdog: ReturnType<typeof setTimeout> | null = null;
  private externalAuthProbeMarker: object | null = null;
  private externalAuthProbeAbortController: AbortController | null = null;
  private externalAuthRestartKey: string | null = null;
  private externalAuthRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private externalAuthExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private externalAuthRefreshedAt = 0;
  private capabilityBridge: ExternalTabCapabilityBridgeController | null = null;
  private capabilityBridgeFrame: HTMLIFrameElement | null = null;
  private capabilityBridgeFrameLoadSeen = false;
  private capabilityBridgeBootstrapMounted = false;
  private capabilityBridgeBootstrapPort: MessagePort | null = null;
  private capabilityBridgeBootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  private capabilityBridgeReconnectRequired = false;
  private capabilityBridgeMountKey: string | null = null;
  private capabilityBridgeDocumentKey: string | null = null;
  private capabilityBridgeDocumentAbortController: AbortController | null = null;
  private capabilityBridgeMutationAuthorityKey: string | null = null;
  private capabilityBridgeMutationNamespace: string | null = null;
  private capabilityBridgeMutationState: ExternalTabCapabilityBridgeMutationState | null = null;
  private stopCapabilityBridgeGatewayEvents: (() => void) | null = null;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      (gateway) => this.updateGatewaySource(gateway),
    )
    .watch(
      () => this.context?.sessions,
      (sessions, notify) => sessions.subscribe(notify),
    );

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState !== "visible" || !this.externalAuthTargetKey) {
      return;
    }
    if (Date.now() - this.externalAuthRefreshedAt >= CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS) {
      // A suspended browser may miss renewal timers. Remove an expired frame
      // until the parent refreshes its route-bound cookie on resume.
      this.externalAuthReadyKey = null;
      this.externalAuthRefreshedAt = 0;
      this.requestExternalTabAuthRestart(this.externalAuthTargetKey);
      return;
    }
    this.refreshExternalTabAuth(this.externalAuthTargetKey);
  };

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("message", this.handleCapabilityBridgeBootstrap);
  }

  override disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener("message", this.handleCapabilityBridgeBootstrap);
    this.clearExternalTabAuth();
    this.clearCapabilityBridge();
    this.clearCapabilityBridgeMutationAuthority();
    this.stopCapabilityBridgeGatewayEvents?.();
    this.stopCapabilityBridgeGatewayEvents = null;
    this.subscriptions.clear();
    this.stopBundledView();
    super.disconnectedCallback();
  }

  private tabKey(): string {
    return pluginTabKey({ pluginId: this.pluginId, id: this.tabId });
  }

  protected loadBundledView(key: string): Promise<BundledPluginTabView> {
    const load = BUNDLED_TAB_VIEWS[key];
    return load ? load() : Promise.reject(new Error(`Unknown bundled plugin tab: ${key}`));
  }

  private hasCurrentBundledDescriptor(key: string): boolean {
    return this.tabKey() === key && this.tabInfo() !== undefined && key in BUNDLED_TAB_VIEWS;
  }

  private startBundledViewLoad(key: string) {
    const loading = { status: "loading", id: key, token: {} } as const;
    this.bundledViewState = loading;
    const settle = (nextState: BundledPluginTabViewState) => {
      if (
        this.bundledViewState.status !== "loading" ||
        this.bundledViewState.token !== loading.token ||
        !this.hasCurrentBundledDescriptor(key)
      ) {
        return;
      }
      this.bundledViewState = nextState;
      if (nextState.status === "error" && isStaleChunkImportError(nextState.error)) {
        void scheduleStaleChunkReload();
      }
    };
    void this.loadBundledView(key).then(
      (view) => settle({ status: "ready", id: key, view }),
      (error: unknown) => settle({ status: "error", id: key, error }),
    );
  }

  private readonly retryBundledView = () => {
    const viewState = this.bundledViewState;
    if (viewState.status !== "error" || !this.hasCurrentBundledDescriptor(viewState.id)) {
      return;
    }
    if (isStaleChunkImportError(viewState.error)) {
      void retryStaleChunkReloadWhenReachable();
    } else {
      this.bundledViewState = { status: "idle" };
    }
  };

  override willUpdate() {
    if (!this.isConnected) {
      return;
    }
    const key = this.tabKey();
    const info = this.tabInfo();
    const bridgeKey = this.capabilityBridgeIdentity(info);
    if (this.capabilityBridgeMountKey !== null && this.capabilityBridgeMountKey !== bridgeKey) {
      this.clearCapabilityBridge();
    }
    const hasBundledDescriptor = info !== undefined && key in BUNDLED_TAB_VIEWS;
    const viewState = this.bundledViewState;
    // Switching between plugin tabs reuses this element; the previous bundled
    // view must stop its background polling before the next one renders. A
    // descriptor can also disappear in place after disablement or scope loss.
    if (viewState.status !== "idle" && (viewState.id !== key || !hasBundledDescriptor)) {
      this.stopBundledView();
    }
    if (this.bundledViewState.status === "idle" && hasBundledDescriptor) {
      this.startBundledViewLoad(key);
    }
    this.syncExternalTabAuth(info, hasBundledDescriptor);
    this.syncCapabilityBridgeDocument(info, hasBundledDescriptor);
  }

  private externalTabAuthKey(
    info: GatewayControlUiPluginTab | undefined,
    hasBundledDescriptor: boolean,
  ): string | null {
    return info?.path &&
      info.requiresGatewayAuth === true &&
      !hasBundledDescriptor &&
      this.isExternalTabAuthSupported()
      ? `${this.tabKey()}\n${info.path}`
      : null;
  }

  private isExternalTabAuthSupported(): boolean {
    // Secure cross-site cookies work on HTTPS and browser-trusted loopback.
    // Insecure LAN HTTP must not fall back to an ambient bearer substitute.
    return window.isSecureContext;
  }

  protected probeExternalTabAuth(path: string, signal: AbortSignal): Promise<boolean> {
    const url = new URL(path, window.location.href);
    if (url.origin !== window.location.origin) {
      return Promise.resolve(false);
    }
    const random = new Uint8Array(16);
    crypto.getRandomValues(random);
    const nonce = Array.from(random, (value) => value.toString(16).padStart(2, "0")).join("");
    url.searchParams.set(CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY, nonce);
    url.searchParams.set(CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY, window.location.origin);

    return new Promise((resolve) => {
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("sandbox", "allow-scripts");
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (result: boolean) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        window.removeEventListener("message", handleMessage);
        signal.removeEventListener("abort", handleAbort);
        frame.remove();
        resolve(result);
      };
      const handleMessage = (event: MessageEvent) => {
        if (
          event.source === frame.contentWindow &&
          event.data?.type === CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE &&
          event.data?.nonce === nonce
        ) {
          finish(true);
        }
      };
      const handleAbort = () => finish(false);
      window.addEventListener("message", handleMessage);
      signal.addEventListener("abort", handleAbort, { once: true });
      timeout = setTimeout(() => finish(false), EXTERNAL_AUTH_PROBE_TIMEOUT_MS);
      frame.src = url.toString();
      document.body.append(frame);
    });
  }

  private syncExternalTabAuth(
    info: GatewayControlUiPluginTab | undefined,
    hasBundledDescriptor: boolean,
  ) {
    const targetKey = this.externalTabAuthKey(info, hasBundledDescriptor);
    if (this.externalAuthTargetKey !== targetKey) {
      this.clearExternalTabAuth();
      this.externalAuthTargetKey = targetKey;
    }
    if (
      targetKey &&
      this.externalAuthReadyKey !== targetKey &&
      this.externalAuthUnavailableKey !== targetKey
    ) {
      this.refreshExternalTabAuth(targetKey);
    }
  }

  private refreshExternalTabAuth(targetKey: string) {
    const context = this.context;
    if (
      !context ||
      context.gateway.snapshot.phase !== "connected" ||
      this.externalAuthTargetKey !== targetKey ||
      this.externalAuthRefreshMarker ||
      this.externalAuthProbeMarker
    ) {
      return;
    }
    const refreshMarker = {};
    const refreshStartedAt = Date.now();
    const abortController = new AbortController();
    this.externalAuthUnavailableKey = null;
    this.externalAuthRefreshMarker = refreshMarker;
    this.externalAuthRefreshAbortController = abortController;
    this.externalAuthRefreshWatchdog = setTimeout(() => {
      if (this.externalAuthRefreshMarker === refreshMarker) {
        this.requestExternalTabAuthRestart(targetKey);
      }
    }, EXTERNAL_AUTH_REFRESH_TIMEOUT_MS);
    void context.config
      .refresh({ signal: abortController.signal })
      .then((refreshed) => {
        if (
          this.externalAuthRefreshMarker !== refreshMarker ||
          this.externalAuthTargetKey !== targetKey
        ) {
          return;
        }
        const shouldRestart = this.finishExternalTabAuthRefreshAttempt(targetKey);
        if (shouldRestart) {
          this.refreshExternalTabAuth(targetKey);
          return;
        }
        const info = this.tabInfo();
        const path = info?.path;
        const granted =
          refreshed !== null &&
          info !== undefined &&
          path !== undefined &&
          refreshed.pluginFrameGrants.some((grant) => pluginFrameGrantCoversTab(grant, info));
        if (granted) {
          this.startExternalTabAuthProbe(targetKey, path, refreshStartedAt);
        } else if (refreshed) {
          this.externalAuthReadyKey = null;
          this.externalAuthUnavailableKey = targetKey;
          this.externalAuthRefreshedAt = 0;
        } else {
          this.scheduleExternalTabAuthRefresh(targetKey, false);
        }
      })
      .catch(() => {
        if (
          this.externalAuthRefreshMarker !== refreshMarker ||
          this.externalAuthTargetKey !== targetKey
        ) {
          return;
        }
        const shouldRestart = this.finishExternalTabAuthRefreshAttempt(targetKey);
        if (shouldRestart) {
          this.refreshExternalTabAuth(targetKey);
        } else {
          this.scheduleExternalTabAuthRefresh(targetKey, false);
        }
      });
  }

  private startExternalTabAuthProbe(targetKey: string, path: string, refreshedAt: number) {
    this.cancelExternalTabAuthProbe();
    const probeMarker = {};
    const abortController = new AbortController();
    this.externalAuthProbeMarker = probeMarker;
    this.externalAuthProbeAbortController = abortController;
    let probeResult: Promise<boolean>;
    try {
      probeResult = this.probeExternalTabAuth(path, abortController.signal);
    } catch {
      probeResult = Promise.resolve(false);
    }
    void probeResult
      .catch(() => false)
      .then((available) => {
        if (
          this.externalAuthProbeMarker !== probeMarker ||
          this.externalAuthTargetKey !== targetKey
        ) {
          return;
        }
        this.externalAuthProbeMarker = null;
        this.externalAuthProbeAbortController = null;
        if (available) {
          this.externalAuthReadyKey = targetKey;
          this.externalAuthRefreshedAt = refreshedAt;
          this.scheduleExternalTabAuthExpiry(targetKey, refreshedAt);
          this.scheduleExternalTabAuthRefresh(targetKey, true);
          return;
        }
        this.externalAuthReadyKey = null;
        this.externalAuthUnavailableKey = targetKey;
        this.externalAuthRefreshedAt = 0;
        if (this.externalAuthRefreshTimer) {
          clearTimeout(this.externalAuthRefreshTimer);
          this.externalAuthRefreshTimer = null;
        }
        if (this.externalAuthExpiryTimer) {
          clearTimeout(this.externalAuthExpiryTimer);
          this.externalAuthExpiryTimer = null;
        }
      });
  }

  private cancelExternalTabAuthProbe() {
    this.externalAuthProbeMarker = null;
    const abortController = this.externalAuthProbeAbortController;
    this.externalAuthProbeAbortController = null;
    abortController?.abort();
  }

  private finishExternalTabAuthRefreshAttempt(targetKey: string): boolean {
    const shouldRestart = this.externalAuthRestartKey === targetKey;
    if (this.externalAuthRefreshWatchdog) {
      clearTimeout(this.externalAuthRefreshWatchdog);
    }
    this.externalAuthRefreshWatchdog = null;
    this.externalAuthRefreshAbortController = null;
    this.externalAuthRefreshMarker = null;
    this.externalAuthRestartKey = null;
    return shouldRestart;
  }

  private requestExternalTabAuthRestart(targetKey: string) {
    if (this.externalAuthTargetKey !== targetKey) {
      return;
    }
    if (this.externalAuthRefreshMarker) {
      // Wait for abort settlement before starting the replacement request so a
      // stale response cannot overwrite its newer route cookie.
      this.externalAuthRestartKey = targetKey;
      this.externalAuthRefreshAbortController?.abort();
      return;
    }
    if (this.externalAuthProbeMarker) {
      this.cancelExternalTabAuthProbe();
    }
    this.refreshExternalTabAuth(targetKey);
  }

  private scheduleExternalTabAuthExpiry(targetKey: string, refreshedAt: number) {
    if (this.externalAuthExpiryTimer) {
      clearTimeout(this.externalAuthExpiryTimer);
    }
    const delay = Math.max(0, refreshedAt + CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS - Date.now());
    this.externalAuthExpiryTimer = setTimeout(() => {
      this.externalAuthExpiryTimer = null;
      if (this.externalAuthTargetKey !== targetKey || this.externalAuthReadyKey !== targetKey) {
        return;
      }
      // Cookie expiry is independent of renewal completion. Unmount the frame,
      // abandon any hung refresh, and obtain a fresh grant before remounting.
      this.externalAuthReadyKey = null;
      this.externalAuthRefreshedAt = 0;
      if (this.externalAuthRefreshTimer) {
        clearTimeout(this.externalAuthRefreshTimer);
        this.externalAuthRefreshTimer = null;
      }
      this.requestExternalTabAuthRestart(targetKey);
    }, delay);
  }

  private scheduleExternalTabAuthRefresh(targetKey: string, refreshed: boolean) {
    if (this.externalAuthRefreshTimer) {
      clearTimeout(this.externalAuthRefreshTimer);
    }
    const delay = refreshed ? CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2 : 5_000;
    this.externalAuthRefreshTimer = setTimeout(() => {
      this.externalAuthRefreshTimer = null;
      this.refreshExternalTabAuth(targetKey);
    }, delay);
  }

  private clearExternalTabAuth() {
    if (this.externalAuthRefreshTimer) {
      clearTimeout(this.externalAuthRefreshTimer);
    }
    if (this.externalAuthExpiryTimer) {
      clearTimeout(this.externalAuthExpiryTimer);
    }
    if (this.externalAuthRefreshWatchdog) {
      clearTimeout(this.externalAuthRefreshWatchdog);
    }
    this.externalAuthRefreshAbortController?.abort();
    this.cancelExternalTabAuthProbe();
    this.externalAuthRefreshTimer = null;
    this.externalAuthExpiryTimer = null;
    this.externalAuthRefreshWatchdog = null;
    this.externalAuthRefreshAbortController = null;
    this.externalAuthRefreshMarker = null;
    this.externalAuthRestartKey = null;
    this.externalAuthTargetKey = null;
    this.externalAuthReadyKey = null;
    this.externalAuthUnavailableKey = null;
    this.externalAuthRefreshedAt = 0;
  }

  private resetExternalTabAuthForGatewayChange(targetKey: string, connected: boolean) {
    if (this.externalAuthRefreshTimer) {
      clearTimeout(this.externalAuthRefreshTimer);
      this.externalAuthRefreshTimer = null;
    }
    if (this.externalAuthExpiryTimer) {
      clearTimeout(this.externalAuthExpiryTimer);
      this.externalAuthExpiryTimer = null;
    }
    this.externalAuthReadyKey = null;
    this.externalAuthUnavailableKey = null;
    this.externalAuthRefreshedAt = 0;
    this.externalAuthTargetKey = targetKey;
    this.cancelExternalTabAuthProbe();
    if (this.externalAuthRefreshMarker) {
      this.externalAuthRestartKey = connected ? targetKey : null;
      this.externalAuthRefreshAbortController?.abort();
    } else if (connected) {
      this.refreshExternalTabAuth(targetKey);
    }
  }

  private stopBundledView() {
    this.replaceBundledViewHost();
    this.bundledViewState = { status: "idle" };
  }

  private replaceBundledViewHost() {
    if (this.bundledViewState.status === "ready") {
      this.bundledViewState.view.stop(this.bundledViewHost);
    }
    // Async controller work is keyed by host. A new host makes every completion
    // from the retired connection epoch unreachable without coupling plugins to Lit.
    this.bundledViewHost = {};
  }

  private updateGatewaySource(gateway: ApplicationContext<RouteId>["gateway"]) {
    const { client } = gateway.snapshot;
    const connected = gateway.snapshot.phase === "connected";
    if (
      this.gatewaySource === gateway &&
      this.gatewayClient === client &&
      this.gatewayConnected === connected
    ) {
      return;
    }
    const externalAuthTargetKey = this.externalAuthTargetKey;
    this.clearCapabilityBridge();
    this.stopCapabilityBridgeGatewayEvents?.();
    this.stopCapabilityBridgeGatewayEvents = null;
    this.replaceBundledViewHost();
    this.gatewaySource = gateway;
    this.gatewayClient = client;
    this.gatewayConnected = connected;
    if (connected) {
      this.capabilityBridgeReconnectRequired = false;
    }
    if (client) {
      this.stopCapabilityBridgeGatewayEvents = client.addEventListener((event) => {
        if (
          event.event !== "config.changed" ||
          this.gatewayClient !== client ||
          !this.tabInfo()?.capabilityBridge
        ) {
          return;
        }
        // Plugin reloads hot-swap the server registry without replacing this
        // browser client. Drop the port before reconnecting so its old grant
        // cannot survive a disablement or runtime replacement.
        // This also applies during the auth probe: it must not turn the old
        // hello grant into a newly mounted port after the runtime changed.
        this.capabilityBridgeReconnectRequired = true;
        this.clearCapabilityBridge();
        client.forceReconnect("plugin runtime changed");
      });
    }
    if (externalAuthTargetKey) {
      this.resetExternalTabAuthForGatewayChange(externalAuthTargetKey, connected);
    }
  }

  private tabInfo(): GatewayControlUiPluginTab | undefined {
    const tabs = this.context?.gateway.snapshot.hello?.controlUiTabs ?? [];
    return tabs.find((tab) => tab.pluginId === this.pluginId && tab.id === this.tabId);
  }

  private pluginFrameUrl(path: string): string {
    const target = this.notificationTarget;
    if (!target || target.pluginId !== this.pluginId || target.tabId !== this.tabId) {
      return path;
    }
    try {
      const url = new URL(path, window.location.origin);
      if (url.origin !== window.location.origin) {
        return path;
      }
      // The authenticated plugin-tab route owns this frame URL. Put the bounded selector
      // on its initial same-origin load rather than postMessaging an opaque sandbox frame.
      url.searchParams.set("openclawNotification", "plugin-detail");
      url.searchParams.set("destination", target.destinationId);
      url.searchParams.set("record", target.recordId);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return path;
    }
  }

  private capabilityBridgeIdentity(info: GatewayControlUiPluginTab | undefined): string | null {
    const mutationNamespace = this.mutationNamespaceForCapabilityBridge(info);
    if (!info?.capabilityBridge || !mutationNamespace) {
      return null;
    }
    return JSON.stringify({
      tab: this.tabKey(),
      path: info.path ? this.pluginFrameUrl(info.path) : info.path,
      grant: info.capabilityBridge,
      conn: this.context?.gateway.snapshot.hello?.server?.connId,
      // This opaque marker causes a remount when parent auth changes without
      // retaining a credential in the document identity.
      authGeneration: mutationNamespace,
    });
  }

  private capabilityBridgeAuthIdentity() {
    const auth = this.context?.gateway.snapshot.hello?.auth;
    if (!auth?.authorityId) {
      return null;
    }
    // The server derives this opaque marker from the authenticated operator and
    // generation. Older hellos lack it and therefore retain the read-only route.
    return { authorityId: auth.authorityId };
  }

  private mutationNamespaceForCapabilityBridge(
    info: GatewayControlUiPluginTab | undefined,
  ): string | null {
    const auth = this.capabilityBridgeAuthIdentity();
    if (!info?.capabilityBridge || !auth) {
      // Gateway clears hello while reconnecting. Preserve the host-only ledger
      // until the replacement hello can prove whether this authority changed.
      if (this.context?.gateway.snapshot.phase === "connected") {
        this.clearCapabilityBridgeMutationAuthority();
      }
      return null;
    }
    const authorityKey = JSON.stringify({
      tab: this.tabKey(),
      path: info.path,
      grant: info.capabilityBridge,
      auth,
    });
    if (authorityKey !== this.capabilityBridgeMutationAuthorityKey) {
      this.capabilityBridgeMutationAuthorityKey = authorityKey;
      // This is host-only but deterministic for the authenticated plugin/tab.
      // Core idempotency must survive a full parent reload, while an auth change
      // gets a distinct namespace before any sandbox mutation can be retried.
      this.capabilityBridgeMutationNamespace = [
        "v1",
        encodeURIComponent(auth.authorityId),
        encodeURIComponent(this.tabKey()),
      ].join(":");
      this.capabilityBridgeMutationState = this.createCapabilityBridgeMutationState(
        this.capabilityBridgeMutationNamespace,
      );
    }
    return this.capabilityBridgeMutationNamespace;
  }

  private createCapabilityBridgeMutationState(namespace: string) {
    const tombstones = new Map<string, string>();
    const storageKey = `${CAPABILITY_BRIDGE_MUTATION_TOMBSTONES_STORAGE_PREFIX}${namespace}`;
    const unavailable = () =>
      createExternalTabCapabilityBridgeMutationState({
        tombstones,
        persistTombstones: () => false,
      });
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (!isRecord(parsed)) {
          return unavailable();
        }
        const entries = Object.entries(parsed);
        if (entries.length > EXTERNAL_TAB_BRIDGE_MAX_MUTATION_OPERATIONS) {
          return unavailable();
        }
        for (const [operationId, method] of entries) {
          if (
            operationId.length > 128 ||
            operationId.length === 0 ||
            typeof method !== "string" ||
            method.length === 0
          ) {
            return unavailable();
          }
          tombstones.set(operationId, method);
        }
      }
      return createExternalTabCapabilityBridgeMutationState({
        tombstones,
        persistTombstones: () => {
          try {
            sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(tombstones)));
            return true;
          } catch {
            return false;
          }
        },
      });
    } catch {
      // A storage failure or malformed tombstone must not authorize a retry.
      // Core mutations still have Gateway idempotency; plugin writes fail closed.
      return unavailable();
    }
  }

  private clearCapabilityBridgeMutationAuthority() {
    this.capabilityBridgeMutationAuthorityKey = null;
    this.capabilityBridgeMutationNamespace = null;
    this.capabilityBridgeMutationState = null;
  }

  private revokeCapabilityBridge() {
    this.capabilityBridge?.revoke();
    this.capabilityBridge = null;
  }

  private clearCapabilityBridge() {
    this.revokeCapabilityBridge();
    if (this.capabilityBridgeBootstrapTimer) {
      clearTimeout(this.capabilityBridgeBootstrapTimer);
    }
    this.capabilityBridgeBootstrapTimer = null;
    this.capabilityBridgeBootstrapPort?.close();
    this.capabilityBridgeBootstrapPort = null;
    this.capabilityBridgeFrame = null;
    this.capabilityBridgeFrameLoadSeen = false;
    this.capabilityBridgeBootstrapMounted = false;
    this.capabilityBridgeMountKey = null;
    this.clearCapabilityBridgeDocument();
  }

  private clearCapabilityBridgeDocument() {
    this.capabilityBridgeDocumentAbortController?.abort();
    this.capabilityBridgeDocumentAbortController = null;
    this.capabilityBridgeDocumentKey = null;
    this.capabilityBridgeDocument = null;
  }

  /** Fetches a redirect-free same-origin response before it becomes a bridge target. */
  protected async loadCapabilityBridgeDocument(
    path: string,
    signal: AbortSignal,
  ): Promise<{ source: URL; markup: string } | null> {
    if (!isSameOriginFramePath(path)) {
      return null;
    }
    const source = new URL(path, window.location.href);
    source.hash = "";
    const response = await fetch(source, {
      credentials: "same-origin",
      redirect: "error",
      signal,
    });
    const loaded = new URL(response.url);
    if (
      !response.ok ||
      response.redirected ||
      loaded.origin !== source.origin ||
      loaded.pathname !== source.pathname ||
      loaded.search !== source.search ||
      !response.headers.get("content-type")?.toLowerCase().includes("text/html")
    ) {
      return null;
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CAPABILITY_BRIDGE_DOCUMENT_BYTES) {
      return null;
    }
    const markup = await response.text();
    if (new TextEncoder().encode(markup).byteLength > MAX_CAPABILITY_BRIDGE_DOCUMENT_BYTES) {
      return null;
    }
    return { source, markup };
  }

  private syncCapabilityBridgeDocument(
    info: GatewayControlUiPluginTab | undefined,
    hasBundledDescriptor: boolean,
  ) {
    const key = this.capabilityBridgeIdentity(info);
    const mutationNamespace = this.mutationNamespaceForCapabilityBridge(info);
    const externalAuthKey = this.externalTabAuthKey(info, hasBundledDescriptor);
    if (
      !key ||
      !mutationNamespace ||
      !info?.path ||
      info.requiresGatewayAuth !== true ||
      this.capabilityBridgeReconnectRequired ||
      this.externalAuthReadyKey !== externalAuthKey
    ) {
      if (
        this.capabilityBridgeFrame ||
        this.capabilityBridgeBootstrapPort ||
        this.capabilityBridge
      ) {
        // Auth renewal and tab projection changes can remove the iframe before
        // it loads again; closing the host side prevents that old port surviving.
        this.clearCapabilityBridge();
      } else if (this.capabilityBridgeDocumentKey !== null) {
        this.clearCapabilityBridgeDocument();
      }
      return;
    }
    if (this.capabilityBridgeDocumentKey === key) {
      return;
    }
    this.clearCapabilityBridgeDocument();
    const abortController = new AbortController();
    this.capabilityBridgeDocumentKey = key;
    this.capabilityBridgeDocumentAbortController = abortController;
    void this.loadCapabilityBridgeDocument(this.pluginFrameUrl(info.path), abortController.signal)
      .then((loaded) => {
        if (
          !loaded ||
          this.capabilityBridgeDocumentKey !== key ||
          this.capabilityBridgeDocumentAbortController !== abortController
        ) {
          return;
        }
        const bootstrapId = randomBridgeBootstrapId();
        this.capabilityBridgeDocument = {
          key,
          bootstrapId,
          // Keep the authority nonce through transport remounts, so a retry
          // reuses the same Gateway idempotency key. It rotates when the tab,
          // grant, or authenticated operator/generation changes.
          mutationNamespace,
          markup: buildCapabilityBridgeDocument(loaded.source, loaded.markup, bootstrapId),
        };
      })
      .catch(() => {
        // The existing authenticated frame remains read-only when an exact
        // bridge source cannot be provenance-bound.
      });
  }

  private activateCapabilityBridge() {
    const frame = this.capabilityBridgeFrame;
    if (
      !frame ||
      !this.capabilityBridgeFrameLoadSeen ||
      !this.capabilityBridgeBootstrapMounted ||
      this.capabilityBridgeReconnectRequired ||
      this.capabilityBridge
    ) {
      return;
    }
    const context = this.context;
    const info = this.tabInfo();
    const grant = info?.capabilityBridge;
    const document = this.capabilityBridgeDocument;
    const client = context?.gateway.snapshot.client;
    const port = this.capabilityBridgeBootstrapPort;
    this.capabilityBridgeMountKey = this.capabilityBridgeIdentity(info);
    if (
      !context ||
      !client ||
      !grant ||
      !document ||
      document.key !== this.capabilityBridgeMountKey ||
      !port ||
      info?.requiresGatewayAuth !== true ||
      context.gateway.snapshot.phase !== "connected" ||
      frame.getAttribute("sandbox") !== AUTHENTICATED_EXTERNAL_TAB_SANDBOX ||
      frame.getAttribute("srcdoc") !== document.markup
    ) {
      return;
    }
    const capabilityBridge = new ExternalTabCapabilityBridgeController({
      client,
      grant,
      mutationNamespace: document.mutationNamespace,
      mutationState: this.capabilityBridgeMutationState ?? undefined,
      // Hello carries the authenticated plugin/tab link set. Do not infer
      // authority from the Control UI's globally selected session.
      linkedSessionKeys: grant.linkedSessionKeys,
      navigate: (sessionKey) => {
        const target = sessionNavigationTarget({
          face: "chat",
          sessionKey,
          fallbackAgentId: "main",
          basePath: context.basePath,
        });
        window.location.assign(target.href);
      },
      onHandshakeFailure: () => {
        if (this.capabilityBridge !== capabilityBridge) {
          return;
        }
        // An absent or incompatible plugin handshake must not leave a dead
        // sandbox mounted. Keep the authenticated direct route read-only until
        // a connection epoch refreshes the declared bridge contract.
        this.capabilityBridgeReconnectRequired = true;
        this.clearCapabilityBridge();
      },
    });
    this.capabilityBridge = capabilityBridge;
    this.capabilityBridgeBootstrapPort = null;
    if (this.capabilityBridgeBootstrapTimer) {
      clearTimeout(this.capabilityBridgeBootstrapTimer);
    }
    this.capabilityBridgeBootstrapTimer = null;
    this.capabilityBridge.connect(port);
  }

  private readonly handleCapabilityBridgeBootstrap = (event: MessageEvent) => {
    const document = this.capabilityBridgeDocument;
    const frame = this.renderRoot.querySelector("iframe");
    if (
      !document ||
      !(frame instanceof HTMLIFrameElement) ||
      event.source !== frame.contentWindow ||
      event.data?.id !== document.bootstrapId ||
      frame.getAttribute("srcdoc") !== document.markup
    ) {
      return;
    }
    if (event.data.type === CAPABILITY_BRIDGE_BOOTSTRAP_MOUNTED_MESSAGE) {
      if (event.ports.length !== 0 || this.capabilityBridgeFrame !== frame) {
        return;
      }
      this.capabilityBridgeBootstrapMounted = true;
      this.activateCapabilityBridge();
      return;
    }
    if (event.data.type !== CAPABILITY_BRIDGE_BOOTSTRAP_MESSAGE || event.ports.length !== 1) {
      return;
    }
    if (this.capabilityBridgeFrame && this.capabilityBridgeFrame !== frame) {
      return;
    }
    if (this.capabilityBridge || this.capabilityBridgeBootstrapPort) {
      event.ports[0]?.close();
      return;
    }
    this.capabilityBridgeFrame = frame;
    this.capabilityBridgeBootstrapPort = event.ports[0] ?? null;
    this.capabilityBridgeBootstrapMounted = false;
    this.capabilityBridgeMountKey = this.capabilityBridgeIdentity(this.tabInfo());
    this.capabilityBridgeBootstrapTimer = setTimeout(() => {
      if (!this.capabilityBridgeBootstrapMounted) {
        this.clearCapabilityBridge();
      }
    }, EXTERNAL_TAB_BRIDGE_LIMITS.handshakeTimeoutMs);
    this.activateCapabilityBridge();
  };

  private readonly bindCapabilityBridge = (event: Event) => {
    const frame = event.currentTarget;
    if (!(frame instanceof HTMLIFrameElement)) {
      return;
    }
    if (this.capabilityBridgeFrame && this.capabilityBridgeFrame !== frame) {
      return;
    }
    if (this.capabilityBridgeFrameLoadSeen) {
      // A bridge bootstrap gives the host its own port; a later navigation
      // destroys the iframe peer. Clear the host side synchronously too.
      this.clearCapabilityBridge();
      return;
    }
    this.capabilityBridgeFrame = frame;
    this.capabilityBridgeFrameLoadSeen = true;
    this.activateCapabilityBridge();
  };

  override render() {
    const context = this.context;
    if (!context) {
      return nothing;
    }
    // Only advertised tabs render: hello omits descriptors whose plugin is
    // inactive or whose required scopes the connection lacks.
    const info = this.tabInfo();
    if (info && this.tabKey() in BUNDLED_TAB_VIEWS) {
      const viewState = this.bundledViewState;
      if (viewState.status === "loading") {
        return renderLoadingState();
      }
      if (viewState.status === "error") {
        return renderLazyViewError({
          error: viewState.error,
          onRetry: this.retryBundledView,
          stale: isStaleChunkImportError(viewState.error),
        });
      }
      if (viewState.status !== "ready") {
        return nothing;
      }
      const snapshot = context.gateway.snapshot;
      const config = context.config?.current;
      return viewState.view.render({
        host: this.bundledViewHost,
        client: snapshot.client,
        connected: snapshot.phase === "connected",
        embed: config
          ? {
              embedSandboxMode: config.embedSandboxMode,
              allowExternalEmbedUrls: config.allowExternalEmbedUrls,
            }
          : undefined,
        onRequestUpdate: () => this.requestUpdate(),
        basePath: context.basePath,
        sessionKey: snapshot.sessionKey,
        sessionListRevision: context.sessions?.canonicalListRevision,
        canApproveWidgets: hasOperatorApprovalsAccess(snapshot.hello?.auth ?? null),
      });
    }
    if (info?.path) {
      const bridge = info.capabilityBridge;
      const sandbox =
        info.requiresGatewayAuth === true
          ? AUTHENTICATED_EXTERNAL_TAB_SANDBOX
          : resolveEmbedSandbox(context.config.current.embedSandboxMode);
      const bridgeDocument = this.capabilityBridgeDocument;
      const bridgeIdentity = this.capabilityBridgeIdentity(info);
      const bridgeEnabled =
        info.requiresGatewayAuth === true &&
        bridge !== undefined &&
        !this.capabilityBridgeReconnectRequired &&
        bridgeDocument?.key === bridgeIdentity;
      const frameKey = [
        this.tabKey(),
        info.path,
        bridgeIdentity ?? "",
        bridgeEnabled ? "bridge" : "read",
      ].join("\n");
      if (info.requiresGatewayAuth === true && !this.isExternalTabAuthSupported()) {
        return html`
          <section class="card lazy-view-state" role="status">
            <div class="card-title">${t("login.failure.insecure.title")}</div>
            <div class="card-sub">${t("login.failure.insecure.stepHttps")}</div>
          </section>
        `;
      }
      const externalAuthKey = this.externalTabAuthKey(info, false);
      if (
        info.requiresGatewayAuth === true &&
        this.externalAuthUnavailableKey === externalAuthKey
      ) {
        return html`
          <section class="card lazy-view-state" role="status">
            <div class="card-title">${t("pluginTabs.unavailableTitle")}</div>
            <div class="card-sub">${t("pluginTabs.unavailableSubtitle")}</div>
          </section>
        `;
      }
      if (info.requiresGatewayAuth === true && this.externalAuthReadyKey !== externalAuthKey) {
        return nothing;
      }
      return html`
        <section class="plugin-tab-embed">
          ${info.requiresGatewayAuth === true && (!bridgeEnabled || bridge.upgradeRequired)
            ? html`<p class="plugin-tab-embed__notice" role="status">
                ${t("pluginTabs.bridgeReadOnlyNotice")}
              </p>`
            : nothing}
          ${keyed(
            frameKey,
            html`<iframe
              class="plugin-tab-embed__frame"
              src=${bridgeEnabled ? nothing : this.pluginFrameUrl(info.path)}
              srcdoc=${bridgeEnabled ? (bridgeDocument?.markup ?? nothing) : nothing}
              title=${info.label}
              sandbox=${sandbox}
              @load=${bridgeEnabled ? this.bindCapabilityBridge : nothing}
            ></iframe>`,
          )}
        </section>
      `;
    }
    return html`
      <section class="card lazy-view-state" role="status">
        <div class="card-title">${t("pluginTabs.unavailableTitle")}</div>
        <div class="card-sub">${t("pluginTabs.unavailableSubtitle")}</div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-plugin-page")) {
  customElements.define("openclaw-plugin-page", PluginPage);
}
