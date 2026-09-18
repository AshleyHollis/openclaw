import type {
  ControlUiDisposer,
  ControlUiHost,
  ControlUiHttpRequest,
  ControlUiHttpResponse,
  ControlUiPageNavigationOptions,
  ControlUiPageTarget,
} from "../../../src/plugin-sdk/control-ui.js";
import type { RouteId } from "../app-route-paths.ts";
import { isRouteId, pathForRoute, pluginTabLocation } from "../app-route-paths.ts";
import { selectApplicationSession } from "../app/agent-selection.ts";
import type { ApplicationContext } from "../app/context.ts";
import { hasOperatorReadAccess, readGatewayOperatorAccess } from "../app/operator-access.ts";
import { i18n } from "../i18n/index.ts";
import { redactToolPayloadText } from "../lib/browser-redact.ts";
import {
  resolveSessionPreferredFaceForKey,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import { normalizeSessionKeyForUiComparison } from "../lib/sessions/session-key.ts";
import { generateUUID } from "../lib/uuid.ts";
import { createControlUiComponents } from "./control-ui-components.ts";
import type { ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";

const DECLARED_PLUGIN_HTTP_ROUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "command-center",
    new Set([
      "/plugins/command-center/api/topics/actions",
      "/plugins/command-center/api/topic/actions",
    ]),
  ],
]);

function declaredPluginHttpRoute(pluginId: string, request: ControlUiHttpRequest): string {
  if (request.method !== "POST" || typeof request.body !== "string") {
    throw new Error("Unsupported plugin HTTP request.");
  }
  const routes = DECLARED_PLUGIN_HTTP_ROUTES.get(pluginId);
  if (!routes?.has(request.path)) {
    throw new Error("Undeclared plugin HTTP route.");
  }
  if (new TextEncoder().encode(request.body).byteLength > 12 * 1024 * 1024) {
    throw new Error("Plugin HTTP request exceeds the supported size.");
  }
  return request.path;
}

async function relayDeclaredPluginHttpRequest(
  context: ApplicationContext<RouteId>,
  pluginId: string,
  request: ControlUiHttpRequest,
  signal?: AbortSignal,
): Promise<ControlUiHttpResponse> {
  const path = declaredPluginHttpRoute(pluginId, request);
  // Browser bootstrap uses a short-lived device credential rather than a
  // persistent bearer token. Both values remain host-only; the plugin sees
  // only the closed request/response envelope.
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
    signal,
  });
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > 1024 * 1024) {
    throw new Error("Plugin HTTP response exceeds the supported size.");
  }
  return { status: response.status, body };
}

export function createControlUiPluginHost(
  getContext: () => ApplicationContext<RouteId>,
  runtime: ControlUiPluginRuntime,
  owner: Omit<ControlUiPluginOwner, "host">,
): ControlUiHost {
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
  const call = async <T>(operation: (context: ApplicationContext<RouteId>) => Promise<T>) => {
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
    redact: redactToolPayloadText,
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
    request: (method, params = {}) => call(() => owner.client.request(method, params)),
    httpRequest: (request, options) =>
      call((context) =>
        relayDeclaredPluginHttpRequest(
          context,
          owner.descriptor.pluginId,
          request,
          options?.signal,
        ),
      ),
    onEvent(event, listener) {
      return retain(
        current().gateway.subscribeEvents((frame) => {
          if (runtime.isCurrent(owner) && frame.event === event) {
            listener(frame.payload);
          }
        }),
      );
    },
    subscribe(listener) {
      const context = current();
      const notify = () => {
        if (runtime.isCurrent(owner)) {
          listener();
        }
      };
      const stops = [
        context.gateway.subscribe(notify),
        context.sessions.subscribe(notify),
        context.agents.subscribe(notify),
        context.agentSelection.subscribe(notify),
        context.theme.subscribe(notify),
        i18n.subscribe(notify),
      ];
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
        const context = current();
        const face = resolveSessionPreferredFaceForKey(context, sessionKey, agentId);
        const target = sessionNavigationTarget({
          context,
          face,
          sessionKey,
          agentId,
          preferenceDerivedFace: true,
          exactKey: true,
        });
        selectApplicationSession({
          selection: context.agentSelection,
          gateway: context.gateway,
          sessionKey,
          agentId,
        });
        context.navigate(face, target.options);
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
        const search = new URLSearchParams(target.options.search ?? "");
        // A fresh request must reopen Files even when the selected Chat has not changed.
        search.set("__openclawFilesPanel", generateUUID());
        context.navigate("chat", { ...target.options, search: `?${search.toString()}` });
      },
      create: (params) => call((context) => context.sessions.create(params)),
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
      registerPanel: (value) => runtime.register(owner, "panels", value),
      registerAction: (value) => runtime.register(owner, "actions", value),
      registerAccessory: (value) => runtime.register(owner, "accessories", value),
      registerWidget: (value) => runtime.register(owner, "widgets", value),
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
