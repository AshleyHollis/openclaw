import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

const notificationId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type PluginNotificationNavigation = {
  kind: "plugin-detail";
  pluginId: string;
  tabId: string;
  destinationId: string;
  recordId: string;
};

type PluginTabRef = {
  pluginId: string;
  id: string;
  notificationTarget?: PluginNotificationNavigation;
};

function notificationTargetFromSearch(
  params: URLSearchParams,
  pluginId: string,
  tabId: string,
): PluginNotificationNavigation | undefined {
  const destinationId = params.get("destination")?.trim();
  const recordId = params.get("record")?.trim();
  if (
    params.get("notification") !== "plugin-detail" ||
    !notificationId.test(pluginId) ||
    !notificationId.test(tabId) ||
    !destinationId ||
    !recordId ||
    !notificationId.test(destinationId) ||
    !notificationId.test(recordId)
  ) {
    return undefined;
  }
  return { kind: "plugin-detail", pluginId, tabId, destinationId, recordId };
}

/** Reads the plugin tab reference from a `/plugin?plugin=<pluginId>&id=<tab>` search string. */
export function pluginTabRefFromSearch(search: string): PluginTabRef {
  const params = new URLSearchParams(search);
  const pluginId = params.get("plugin")?.trim() ?? "";
  const id = params.get("id")?.trim() ?? "";
  const notificationTarget = notificationTargetFromSearch(params, pluginId, id);
  return {
    pluginId,
    id,
    ...(notificationTarget ? { notificationTarget } : {}),
  };
}

export function pluginTabSearch(ref: PluginTabRef): string {
  return `?${new URLSearchParams({ plugin: ref.pluginId, id: ref.id }).toString()}`;
}

/** Stable key for one tab; ids are only unique per plugin, so both parts matter. */
export function pluginTabKey(ref: PluginTabRef): string {
  return `${ref.pluginId}/${ref.id}`;
}

// One static route hosts every plugin-declared tab; the router only supports
// exact paths, so the tab reference travels in the query.
export const page = definePage({
  ...routePageSpec("plugin"),
  loaderDeps: (_context, location) => location.search,
  loader: (_context, options) => pluginTabRefFromSearch(options.location.search),
  component: () =>
    import("./plugin-page.ts").then(() => ({
      header: true,
      render: (data: unknown) => {
        const ref = (data ?? { pluginId: "", id: "" }) as PluginTabRef;
        return html`<openclaw-plugin-page
          .pluginId=${ref.pluginId}
          .tabId=${ref.id}
          .notificationTarget=${ref.notificationTarget}
        >
        </openclaw-plugin-page>`;
      },
    })),
});
