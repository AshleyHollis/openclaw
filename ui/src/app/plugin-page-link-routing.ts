import type { ControlUiPageTarget } from "../../../src/plugin-sdk/control-ui.js";
import { pathForRoute } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { anchorFromNavigationEvent, shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { showToast } from "../lib/toast.ts";
import type { ApplicationContext } from "./context.ts";

/** Only the canonical plugin-page URL emitted by pageHref; no inherited search. */
function pluginPageLinkTarget(url: URL): ControlUiPageTarget | null {
  if (url.hash || url.username || url.password) {
    return null;
  }
  const seen = new Set<string>();
  const params: Record<string, string> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || (key !== "plugin" && key !== "id" && !key.startsWith("p."))) {
      return null;
    }
    seen.add(key);
    if (key.startsWith("p.")) {
      if (key.length === 2) {
        return null;
      }
      params[key.slice(2)] = value;
    }
  }
  const pluginId = url.searchParams.get("plugin"),
    id = url.searchParams.get("id");
  return pluginId && id && pluginId.trim() === pluginId && id.trim() === id
    ? { pluginId, id, params }
    : null;
}

/** The native link owner consumes the current page owner's existing navigation contract. */
export function startPluginPageLinkRouting(getContext: () => ApplicationContext) {
  const onClick = (event: MouseEvent) => {
    if (!shouldHandleNavigationClick(event)) {
      return;
    }
    const anchor = anchorFromNavigationEvent(event);
    if (
      !anchor?.hasAttribute("href") ||
      anchor.hasAttribute("download") ||
      anchor.hasAttribute("data-file-path") ||
      anchor.hasAttribute("data-link-reader-external") ||
      (anchor.target && anchor.target !== "_self") ||
      !event
        .composedPath()
        .some((node) => node instanceof Element && node.localName === "openclaw-app-shell")
    ) {
      return;
    }
    const context = getContext();
    let url: URL;
    try {
      url = new URL(anchor.href, window.location.href);
    } catch {
      return;
    }
    if (
      url.origin !== window.location.origin ||
      url.pathname !== pathForRoute("plugin", context.basePath)
    ) {
      return;
    }
    // A same-app page failure must leave the current Conversation mounted.
    event.preventDefault();
    try {
      const target = pluginPageLinkTarget(url);
      const entries = target
        ? context.plugins
            .registrations("pages")
            .filter(
              (entry) =>
                entry.pluginId === target.pluginId &&
                entry.value.id === target.id &&
                !entry.signal.aborted,
            )
        : [];
      const entry = entries.length === 1 ? entries[0] : undefined;
      if (!target || !entry || !entry.host.connection.connected || !entry.host.connection.canRead) {
        throw new Error("Plugin page unavailable");
      }
      // This host belongs to the selected live registration. Same-plugin detail
      // pages need not advertise a tab. Its host rechecks activation/client;
      // the application router also preserves the embedded native handoff.
      const ownTarget = { id: target.id, params: target.params };
      const expected = new URL(entry.host.navigation.pageHref(ownTarget), window.location.href);
      const wanted = new URL(url);
      expected.searchParams.sort();
      wanted.searchParams.sort();
      if (expected.href !== wanted.href || entry.signal.aborted) {
        throw new Error("Plugin page unavailable");
      }
      entry.host.navigation.openPage(ownTarget);
    } catch {
      showToast({ message: t("pluginTabs.unavailableTitle") });
    }
  };
  document.addEventListener("click", onClick);
  return { dispose: () => document.removeEventListener("click", onClick) };
}
