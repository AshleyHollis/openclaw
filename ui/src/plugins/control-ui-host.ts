import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ControlUiDisposer,
  ControlUiHost,
  ControlUiPageNavigationOptions,
  ControlUiPageTarget,
} from "../../../src/plugin-sdk/control-ui.js";
import { isControlUiHttpRoute } from "../../../src/plugins/control-ui-http-routes.js";
import { isPluginInlineViewVersion } from "../../../src/shared/plugin-inline-view.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { serializeSidebarEntry } from "../app-navigation.ts";
import { isRouteId, pathForRoute, pluginTabLocation } from "../app-route-paths.ts";
import { selectApplicationSession } from "../app/agent-selection.ts";
import type { ApplicationContext } from "../app/context.ts";
import { isSameOriginGateway } from "../app/gateway-control-ui-reload.ts";
import { hasOperatorReadAccess, readGatewayOperatorAccess } from "../app/operator-access.ts";
import {
  FILES_PANEL_OPEN_EVENT,
  type FilesPanelOpenDetail,
  PLUGIN_PANEL_TOGGLE_EVENT,
  type PluginPanelToggleDetail,
} from "../components/panel-toggle-contract.ts";
import { rememberSessionPanelToggle } from "../components/session-panel-toggle-buffer.ts";
import { i18n } from "../i18n/index.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import {
  openPreferredApplicationSession,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";
import { createControlUiComponents } from "./control-ui-components.ts";
import { createPluginRecoveryStorage } from "./control-ui-recovery-storage.ts";
import type { ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";

type ControlUiHttpRequest = Parameters<ControlUiHost["httpRequest"]>[0];
type ControlUiHttpResponse = Awaited<ReturnType<ControlUiHost["httpRequest"]>>;

function declaredPluginHttpRoute(
  routes: ReadonlySet<string>,
  request: ControlUiHttpRequest,
): string {
  if (request.method !== "POST" || typeof request.body !== "string") {
    throw new Error("Unsupported plugin HTTP request.");
  }
  if (!routes.has(request.path)) {
    throw new Error("Undeclared plugin HTTP route.");
  }
  if (new TextEncoder().encode(request.body).byteLength > 12 * 1024 * 1024) {
    throw new Error("Plugin HTTP request exceeds the supported size.");
  }
  return request.path;
}

async function relayDeclaredPluginHttpRequest(
  context: ApplicationContext,
  routes: ReadonlySet<string>,
  client: GatewayBrowserClient,
  request: ControlUiHttpRequest,
  signal?: AbortSignal,
): Promise<ControlUiHttpResponse> {
  const path = declaredPluginHttpRoute(routes, request);
  // A manual connection can target another Gateway after this document was served.
  // Never deliver its credential to the serving origin's HTTP recipient.
  if (
    !isSameOriginGateway(client.gatewayUrl) ||
    !isSameOriginGateway(context.gateway.connection.gatewayUrl)
  ) {
    throw new Error("Plugin HTTP access requires the Control UI served by the connected Gateway.");
  }
  const credential = (
    context.gateway.connection.token || context.gateway.connection.bootstrapToken
  ).trim();
  if (!credential) {
    throw new Error("Authenticated plugin HTTP access is unavailable.");
  }
  const target = new URL(path, window.location.origin);
  if (target.origin !== window.location.origin) {
    throw new Error("Plugin HTTP relay must remain same-origin.");
  }
  const response = await fetch(target, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + credential,
      "Content-Type": "application/json",
    },
    body: request.body,
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > 1024 * 1024) {
    throw new Error("Plugin HTTP response exceeds the supported size.");
  }
  return { status: response.status, body };
}

export function createControlUiPluginHost(
  getContext: () => ApplicationContext,
  runtime: ControlUiPluginRuntime,
  owner: Omit<ControlUiPluginOwner, "host">,
): ControlUiHost {
  // Capture this admitted build's declaration; later metadata cannot widen its activation.
  const routes = new Set(
    (owner.descriptor.httpRoutes ?? []).filter((route) =>
      isControlUiHttpRoute(owner.descriptor.pluginId, route),
    ),
  );
  const current = () => {
    if (!runtime.isCurrent(owner)) {
      throw new Error("This plugin UI activation has ended. Use the current activation.");
    }
    return getContext();
  };
  const retain = (dispose: ControlUiDisposer) => {
    if (!runtime.isCurrent(owner)) {
      dispose();
      current();
    }
    owner.disposers.add(dispose);
    return () => {
      owner.disposers.delete(dispose);
      dispose();
    };
  };
  const call = async <T>(operation: (context: ApplicationContext) => Promise<T>) => {
    const result = await operation(current());
    current();
    return result;
  };
  const pageLocation = (
    target: ControlUiPageTarget,
    options?: Pick<ControlUiPageNavigationOptions, "preserveSearch">,
  ) => {
    const context = current();
    const tab = context.gateway.snapshot.hello?.controlUiTabs?.find(
      (candidate) => candidate.pluginId === owner.descriptor.pluginId && candidate.id === target.id,
    );
    const route = tab?.placement?.startsWith("route:")
      ? tab.placement.slice("route:".length)
      : null;
    const nativeRoute = route && isRouteId(route) ? route : null;
    const tabLocation = pluginTabLocation(
      tab ?? { pluginId: owner.descriptor.pluginId, id: target.id },
      context.basePath,
    );
    const path = nativeRoute ? pathForRoute(nativeRoute, context.basePath) : tabLocation.pathname;
    const suffix = nativeRoute ? target.path?.map(encodeURIComponent).join("/") : undefined;
    const search = new URLSearchParams(options?.preserveSearch ? window.location.search : "");
    if (!nativeRoute) {
      search.delete("plugin");
      search.delete("id");
      for (const [key, value] of new URLSearchParams(tabLocation.search)) {
        search.set(key, value);
      }
    }
    for (const [key, value] of Object.entries(target.params ?? {})) {
      search.set(`p.${key}`, value);
    }
    return {
      route: nativeRoute ?? ("plugin" as const),
      pathname: suffix ? `${path}/${suffix}` : path,
      search: search.size ? `?${search}` : "",
    };
  };
  const dock = getContext().assistantDock;
  // Only an activation that actually docked a conversation owns a close-on-dispose.
  let dockCloseRetained = false;
  return {
    apiVersion: 1,
    pluginId: owner.descriptor.pluginId,
    signal: owner.abort.signal,
    get basePath() {
      return current().basePath;
    },
    get locale() {
      return i18n.getLocale();
    },
    redact: redactToolDetail,
    components: createControlUiComponents({
      current,
      signal: owner.abort.signal,
      onError: (error) => runtime.reportError(owner.descriptor.pluginId, error),
    }),
    get connection() {
      const snapshot = current().gateway.snapshot;
      const access = readGatewayOperatorAccess(snapshot);
      return {
        connected: snapshot.phase === "connected",
        canRead: hasOperatorReadAccess(snapshot.hello?.auth ?? null),
        canWrite: access.canWrite,
        canGrant: access.canGrantApprovals,
        canAdmin: access.canAdmin,
        assistantAgentId: snapshot.assistantAgentId,
      };
    },
    get recoveryStorage() {
      return createPluginRecoveryStorage(
        current().gateway,
        owner.client,
        owner.descriptor.pluginId,
        () => {
          current();
        },
      );
    },
    request: (method, params = {}) => call(() => owner.client.request(method, params)),
    httpRequest: (request, options) =>
      call((context) =>
        relayDeclaredPluginHttpRequest(
          context,
          routes,
          owner.client,
          request,
          options?.signal
            ? AbortSignal.any([owner.abort.signal, options.signal])
            : owner.abort.signal,
        ),
      ),
    onEvent(event, listener) {
      return retain(
        current().gateway.subscribeEvents(
          (frame) => {
            if (
              runtime.isCurrent(owner) &&
              frame.event === event &&
              (event !== "session.message" || asOptionalRecord(frame.payload)?.message != null)
            ) {
              listener(frame.payload);
            }
          },
          { includeMessageBodies: event === "session.message" },
        ),
      );
    },
    subscribe(listener) {
      const context = current();
      const notify = () => {
        if (runtime.isCurrent(owner)) {
          listener();
        }
      };
      // The public SDK subscription delivers each owner publication within its activation.
      const stops = [
        context.gateway,
        context.sessions,
        context.agents,
        context.agentSelection,
        context.theme,
        i18n,
        ...(dock ? [dock] : []),
      ].map((source) => source.subscribe(notify));
      return retain(() => stops.forEach((stop) => stop()));
    },
    sessions: {
      get rows() {
        return structuredClone(current().sessions.state.result?.sessions ?? []);
      },
      get selectedKey() {
        return current().gateway.snapshot.sessionKey;
      },
      normalizeKey: normalizeSessionKeyForUiComparison,
      refresh: () =>
        call(async (context) => {
          if ((await context.sessions.refreshReplacement()) === null) {
            throw new Error("The session refresh did not complete. Try again.");
          }
        }),
      observe(query, listener) {
        const { archived, ...options } = query;
        let disposed = false;
        const observer = current().sessions.observeList(
          {
            ...options,
            archivedFilter: archived === "all" ? "all" : archived ? "archived" : "active",
          },
          ({ result, loading, error }) => {
            if (disposed || !runtime.isCurrent(owner)) {
              return;
            }
            try {
              listener({
                loading,
                error,
                result: result
                  ? {
                      sessions: structuredClone(result.sessions),
                      hasMore: result.hasMore,
                      nextOffset: result.nextOffset,
                      totalCount: result.totalCount,
                    }
                  : null,
              });
            } catch (listenerError) {
              runtime.reportError(owner.descriptor.pluginId, listenerError);
            }
          },
        );
        const dispose = retain(() => {
          disposed = true;
          observer.dispose();
        });
        const refresh = () => call(() => observer.refresh());
        void refresh().catch((error: unknown) => {
          if (!disposed && runtime.isCurrent(owner)) {
            runtime.reportError(owner.descriptor.pluginId, error);
          }
        });
        return { refresh, dispose };
      },
      open({ sessionKey, agentId }) {
        openPreferredApplicationSession(current(), sessionKey, agentId);
      },
      openChat({ sessionKey, agentId }) {
        const context = current();
        const target = sessionNavigationTarget({
          context,
          face: "chat",
          sessionKey,
          agentId,
          exactKey: true,
        });
        selectApplicationSession({
          selection: context.agentSelection,
          gateway: context.gateway,
          sessionKey,
          agentId,
        });
        context.navigate("chat", target.options);
      },
      openFiles({ sessionKey, agentId }) {
        const context = current();
        const chatSessionKey = context.gateway.snapshot.sessionKey;
        const event = new CustomEvent<FilesPanelOpenDetail>(FILES_PANEL_OPEN_EVENT, {
          cancelable: true,
          detail: {
            client: owner.client,
            sessionKey: chatSessionKey,
            target: { sessionKey, agentId },
            signal: owner.abort.signal,
          },
        });
        if (window.dispatchEvent(event)) {
          // A non-Chat page has no pane to claim this intent until navigation commits.
          rememberSessionPanelToggle("workspace", event);
          const chat = sessionNavigationTarget({
            context,
            face: "chat",
            sessionKey: chatSessionKey,
            exactKey: true,
          });
          context.navigate("chat", chat.options);
        }
      },
      create: (params) =>
        call((context) => context.sessions.create(params, { signal: owner.abort.signal })),
      patch: ({ sessionKey, agentId }, patch) =>
        call(async (context) => {
          // A plugin query may target another global owner. Its mutation does not
          // own the primary roster's optimistic model or remembered list scope.
          const result = await context.sessions.patch(sessionKey, patch, {
            agentId,
            ownsModelOverride: () => false,
            deferListRefresh: true,
          });
          if (!result) {
            throw new Error("The session update did not complete. Try again.");
          }
          current();
          if ((await context.sessions.refreshReplacement()) === null) {
            throw new Error(
              "The session was updated, but the session list could not be refreshed. Refresh the list to see the change.",
            );
          }
        }),
    },
    agents: {
      get rows() {
        return structuredClone(current().agents.state.agentsList?.agents ?? []);
      },
      get selectedId() {
        return current().agentSelection.state.selectedId;
      },
      get defaultId() {
        return current().agents.state.agentsList?.defaultId ?? null;
      },
      get scopeId() {
        return current().agentSelection.state.scopeId;
      },
      select(agentId) {
        current().agentSelection.set(agentId);
      },
      setScope(agentId) {
        current().agentSelection.setScope(agentId);
      },
      refresh: () =>
        call(async (context) => {
          if ((await context.agents.refreshList()) === null) {
            throw new Error("The agent refresh did not complete. Try again.");
          }
        }),
    },
    dock: dock
      ? {
          openSession(params) {
            current().assistantDock.openSession(params, owner.abort);
            if (!dockCloseRetained) {
              dockCloseRetained = true;
              retain(() => dock.close(owner.abort));
            }
          },
          close() {
            current().assistantDock.close();
          },
          get openSessionKey() {
            return current().assistantDock.openSessionKey;
          },
        }
      : undefined,
    navigation: {
      openPage(target, options) {
        const location = pageLocation(target, options);
        const context = current();
        if (options?.replace) {
          context.replace(location.route, location);
        } else {
          context.navigate(location.route, location);
        }
      },
      pageHref(target, options) {
        const location = pageLocation(target, options);
        return `${location.pathname}${location.search}`;
      },
    },
    ui: {
      invalidate: () => runtime.invalidate(owner),
      registerPage: (value) => runtime.register(owner, "pages", value),
      registerNavigation: (value) => runtime.register(owner, "navigation", value),
      pinNavigation(id) {
        const context = current();
        if (!owner.contributions.navigation.has(id)) {
          return;
        }
        const entry = serializeSidebarEntry({
          type: "plugin",
          key: `${owner.descriptor.pluginId}/${id}`,
        });
        const entries = context.navigation.snapshot.sidebarEntries;
        if (!entries.includes(entry)) {
          context.navigation.update({ sidebarEntries: [...entries, entry] });
        }
      },
      unpinNavigation(id) {
        const context = current();
        const entry = serializeSidebarEntry({
          type: "plugin",
          key: `${owner.descriptor.pluginId}/${id}`,
        });
        const entries = context.navigation.snapshot.sidebarEntries;
        if (entries.includes(entry)) {
          context.navigation.update({ sidebarEntries: entries.filter((value) => value !== entry) });
        }
      },
      isNavigationPinned(id) {
        return current().navigation.snapshot.sidebarEntries.includes(
          serializeSidebarEntry({ type: "plugin", key: `${owner.descriptor.pluginId}/${id}` }),
        );
      },
      registerPanel: (value) => runtime.register(owner, "panels", value),
      openPanel(id, session) {
        const context = current();
        if (!owner.contributions.panels.has(id)) {
          throw new Error("A plugin can open only its own registered panel.");
        }
        const sessionKey = session?.sessionKey ?? context.gateway.snapshot.sessionKey;
        if (!sessionKey) {
          throw new Error("Select a session before opening a plugin panel.");
        }
        const detail: PluginPanelToggleDetail = {
          pluginId: owner.descriptor.pluginId,
          panelId: id,
          sessionKey,
          agentId:
            session?.agentId ??
            parseAgentSessionKey(sessionKey)?.agentId ??
            context.agentSelection.state.selectedId ??
            undefined,
          open: true,
        };
        const event = new CustomEvent(PLUGIN_PANEL_TOGGLE_EVENT, { detail });
        rememberSessionPanelToggle(`plugin:${detail.pluginId}/${id}`, event);
        openPreferredApplicationSession(context, sessionKey, session?.agentId);
        window.dispatchEvent(event);
      },
      registerAction: (value) => runtime.register(owner, "actions", value),
      registerAccessory: (value) => runtime.register(owner, "accessories", value),
      registerWidget: (value) => runtime.register(owner, "widgets", value),
      registerInlineView: (value) => {
        if (!isPluginInlineViewVersion(value.version)) {
          throw new Error("Inline view version must be an integer from 1 to 65535.");
        }
        return runtime.register(owner, "inlineViews", value, value.id + "@" + value.version);
      },
      registerReplacement: (value) => runtime.register(owner, "replacements", value),
      selectReplacement(surface, id) {
        current();
        if (id !== null && owner.contributions.replacements.get(id)?.value.surface !== surface) {
          throw new Error("A plugin can select only its own registered UI replacement.");
        }
        owner.selections.set(surface, id);
        if (
          runtime
            .registrations("replacements")
            .some((entry) => entry.host.signal === owner.abort.signal)
        ) {
          runtime.selectReplacement(
            surface,
            id === null ? null : `${owner.descriptor.pluginId}/${id}`,
          );
        }
      },
    },
  };
}
