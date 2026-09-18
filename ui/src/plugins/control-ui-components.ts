import { html, nothing, render } from "lit";
import type {
  ControlUiComponentHandle,
  ControlUiComponents,
} from "../../../src/plugin-sdk/control-ui-components.js";
import type { RouteId } from "../app-routes.ts";
import type { ApplicationContext } from "../app/context.ts";
import { readGatewayOperatorAccess } from "../app/operator-access.ts";
import { icons } from "../components/icons.ts";
import { renderSessionWorkspaceRail } from "../pages/chat/components/chat-session-workspace-rail.ts";

export function createControlUiComponents(options: {
  current: () => ApplicationContext<RouteId>;
  signal: AbortSignal;
  onError: (error: unknown) => void;
}): ControlUiComponents {
  function mount<P, E extends HTMLElement>(
    container: HTMLElement,
    initial: P,
    load: () => Promise<E>,
    apply: (element: E, props: P, current: () => ApplicationContext<RouteId>) => void,
    listen?: (element: E, props: () => P) => () => void,
  ): ControlUiComponentHandle<P> {
    options.current();
    options.signal.throwIfAborted();
    let props = initial;
    let element: E | undefined;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let unlisten: (() => void) | undefined;
    const current = () => {
      if (!active) {
        throw new Error("This plugin component has been disposed.");
      }
      options.signal.throwIfAborted();
      return options.current();
    };
    const refresh = () => {
      if (element && active) {
        apply(element, props, current);
      }
    };
    const dispose = () => {
      if (!active) {
        return;
      }
      active = false;
      options.signal.removeEventListener("abort", dispose);
      unsubscribe?.();
      unlisten?.();
      element?.remove();
    };
    options.signal.addEventListener("abort", dispose, { once: true });
    void load()
      .then((loaded) => {
        // Imports can finish after navigation or reload. The retired mount must
        // never reconnect a dialog, provider lease, or event callback.
        if (!active || options.signal.aborted) {
          return;
        }
        current();
        element = loaded;
        unlisten = listen?.(element, () => {
          current();
          return props;
        });
        refresh();
        container.append(element);
        const context = current();
        const stops = [context.gateway.subscribe(refresh), context.agents.subscribe(refresh)];
        unsubscribe = () => stops.forEach((stop) => stop());
      })
      .catch((error: unknown) => {
        if (active) {
          dispose();
          options.onError(error);
        }
      });
    return {
      update(next) {
        current();
        props = next;
        refresh();
      },
      dispose,
    };
  }

  return {
    mountFileExplorer: (container, initial) => {
      let props = initial;
      let active = true;
      let pendingScrollRestore: number | undefined;
      let scrollRestoreGeneration = 0;
      const root = document.createElement("div");
      root.className = "control-ui-file-explorer";
      const cancelScrollRestore = () => {
        scrollRestoreGeneration += 1;
        if (pendingScrollRestore !== undefined) {
          cancelAnimationFrame(pendingScrollRestore);
          pendingScrollRestore = undefined;
        }
      };
      const paint = () => {
        if (!active) {
          return;
        }
        cancelScrollRestore();
        const previousScroll = root.querySelector<HTMLElement>(
          ".chat-workspace-rail__scroll",
        )?.scrollTop;
        const treeMode = props.expandedPaths !== undefined;
        const renderTree = () => {
          type Node = {
            folders: Map<string, Node>;
            files: Array<(typeof props.entries)[number]>;
          };
          const rootNode: Node = { folders: new Map(), files: [] };
          for (const entry of props.entries) {
            const parts = entry.path.split("/").filter(Boolean);
            let node = rootNode;
            for (const part of parts.slice(0, -1)) {
              let child = node.folders.get(part);
              if (!child) {
                child = { folders: new Map(), files: [] };
                node.folders.set(part, child);
              }
              node = child;
            }
            if (entry.kind === "directory") {
              // A tree caller can provide explicit empty folders. They remain
              // navigable even before a file is present in them.
              for (const part of parts) {
                let child = node.folders.get(part);
                if (!child) {
                  child = { folders: new Map(), files: [] };
                  node.folders.set(part, child);
                }
                node = child;
              }
            } else {
              node.files.push(entry);
            }
          }
          const expanded = new Set(props.expandedPaths);
          const folderPaths = new Set<string>();
          for (const entry of props.entries) {
            const parts = entry.path.split("/").filter(Boolean);
            const limit = entry.kind === "directory" ? parts.length : Math.max(0, parts.length - 1);
            for (let index = 1; index <= limit; index += 1) {
              folderPaths.add(parts.slice(0, index).join("/"));
            }
          }
          const fileIcon = (name: string) => {
            const extension = name.toLocaleLowerCase().split(".").at(-1) ?? "";
            if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)) {
              return icons.image;
            }
            if (["eml", "msg"].includes(extension)) {
              return icons.mail;
            }
            if (["md", "markdown", "txt", "text"].includes(extension)) {
              return icons.fileText;
            }
            if (extension === "pdf") {
              return icons.scrollText;
            }
            if (["xls", "xlsx", "csv", "ods"].includes(extension)) {
              return icons.layoutGrid;
            }
            return icons.file;
          };
          const updateExpansion = (path: string, open: boolean) => {
            const next = new Set(props.expandedPaths);
            if (open) {
              next.add(path);
            } else {
              next.delete(path);
            }
            props.onExpandedPathsChange?.([...next].toSorted());
          };
          const handleTreeKey = (event: KeyboardEvent) => {
            const tree = event.currentTarget as HTMLElement;
            const controls = [
              ...tree.querySelectorAll<HTMLElement>("summary, .chat-workspace-rail__file-open"),
            ].filter((item) => item.offsetParent !== null);
            const current = event.target as HTMLElement;
            const index = controls.indexOf(current);
            if (index < 0) {
              return;
            }
            const focus = (next: number) =>
              controls[Math.max(0, Math.min(controls.length - 1, next))]?.focus();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              focus(index + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              focus(index - 1);
            } else if (event.key === "Home") {
              event.preventDefault();
              focus(0);
            } else if (event.key === "End") {
              event.preventDefault();
              focus(controls.length - 1);
            } else if (event.key === "ArrowRight" && current.tagName === "SUMMARY") {
              const details = current.parentElement as HTMLDetailsElement;
              if (!details.open) {
                event.preventDefault();
                details.open = true;
                updateExpansion(current.dataset.treePath ?? "", true);
              }
            } else if (event.key === "ArrowLeft" && current.tagName === "SUMMARY") {
              const details = current.parentElement as HTMLDetailsElement;
              if (details.open) {
                event.preventDefault();
                details.open = false;
                updateExpansion(current.dataset.treePath ?? "", false);
              }
            }
          };
          const renderNode = (node: Node, parent = "", nested = false) => html` <ul
            class="chat-workspace-rail__list chat-workspace-rail__list--browser"
            role=${nested ? "group" : "tree"}
          >
            ${[...node.folders.entries()]
              .toSorted(([left], [right]) => left.localeCompare(right))
              .map(([name, child]) => {
                const path = parent ? `${parent}/${name}` : name;
                const open = expanded.has(path);
                return html`<li role="treeitem" aria-expanded=${String(open)}>
                  <details
                    ?open=${open}
                    @toggle=${(event: Event) => updateExpansion(path, (event.currentTarget as HTMLDetailsElement).open)}
                  >
                    <summary
                      class="chat-workspace-rail__file chat-workspace-rail__file--directory"
                      data-tree-path=${path}
                    >
                      <span class="chat-workspace-rail__file-icon">${icons.folder}</span>
                      <span class="chat-workspace-rail__file-main"
                        ><span class="chat-workspace-rail__file-name">${name}</span></span
                      >
                    </summary>
                    ${renderNode(child, path, true)}
                  </details>
                </li>`;
              })}
            ${[...node.files]
              .toSorted((left, right) => left.path.localeCompare(right.path))
              .map(
                (entry) => html` <li
                  class="chat-workspace-rail__file ${props.selectedPath === entry.path ? "chat-workspace-rail__file--active" : ""}"
                  role="treeitem"
                  aria-selected=${String(props.selectedPath === entry.path)}
                >
                  <button
                    class="chat-workspace-rail__file-open"
                    type="button"
                    @click=${() => props.onSelect(entry.path)}
                  >
                    <span class="chat-workspace-rail__file-icon">${fileIcon(entry.name)}</span>
                    <span class="chat-workspace-rail__file-main"
                      ><span class="chat-workspace-rail__file-name">${entry.name}</span></span
                    >
                  </button>
                </li>`,
              )}
          </ul>`;
          return html` <aside class="chat-workspace-rail" aria-label="${props.rootLabel} Files">
            <div class="chat-workspace-rail__path">${props.rootLabel}</div>
            <div class="chat-workspace-rail__toolbar">
              <label class="chat-workspace-rail__search"
                ><span class="chat-workspace-rail__search-icon">${icons.search}</span>
                <input
                  type="search"
                  aria-label="Filter files by name or path"
                  placeholder="Filter filenames or paths…"
                  .value=${props.query}
                  @input=${(event: Event) => props.onQueryChange((event.currentTarget as HTMLInputElement).value)}
                />
              </label>
              ${props.query.trim() ? html`<button class="rail-header__action" type="button" aria-label="Clear file filter" @click=${() => props.onQueryChange("")}>${icons.circleX}</button>` : nothing}
              <button
                class="rail-header__action"
                type="button"
                aria-label="Expand all folders"
                title="Expand all folders"
                ?disabled=${Boolean(props.query.trim())}
                @click=${() => props.onExpandedPathsChange?.([...folderPaths].toSorted())}
              >
                ${icons.arrowDown}
              </button>
              <button
                class="rail-header__action"
                type="button"
                aria-label="Collapse all folders"
                title="Collapse all folders"
                ?disabled=${Boolean(props.query.trim())}
                @click=${() => props.onExpandedPathsChange?.([])}
              >
                ${icons.arrowUp}
              </button>
              <button
                class="rail-header__action chat-workspace-rail__refresh"
                type="button"
                aria-label="Refresh files"
                ?disabled=${props.loading}
                @click=${() => props.onRefresh()}
              >
                ${icons.refresh}
              </button>
            </div>
            <div class="chat-workspace-rail__filter-status" role="status">
              ${props.entries.filter((entry) => entry.kind === "file").length}
              file${props.entries.filter((entry) => entry.kind === "file").length === 1 ? "" : "s"}${props.query.trim() ? " matching filter" : ""}
            </div>
            ${props.query.trim() ? html`<p class="chat-workspace-rail__filter-help">Clear the filter to change folder expansion.</p>` : nothing}
            ${
              props.error
                ? html`<div class="chat-workspace-rail__state chat-workspace-rail__state--error">
                    ${props.error}
                  </div>`
                : props.loading
                  ? html`<div class="chat-workspace-rail__state">Loading Topic files…</div>`
                  : props.entries.length === 0
                    ? html`<div class="chat-workspace-rail__state">
                        ${props.query.trim() ? "No files match this filter." : "No files in this Topic."}
                      </div>`
                    : html` <div
                        class="chat-workspace-rail__scroll"
                        tabindex="0"
                        @keydown=${handleTreeKey}
                      >
                        ${renderNode(rootNode)}
                      </div>`
            }
          </aside>`;
        };
        render(
          treeMode
            ? renderTree()
            : renderSessionWorkspaceRail(
                {
                  filter: "all",
                  browserSearch: props.query,
                  collapsed: false,
                  sessionKey: "plugin:topic-files",
                  list: {
                    sessionKey: "plugin:topic-files",
                    root: props.rootLabel,
                    files: [],
                    artifacts: [],
                    browser: {
                      path: props.currentPath,
                      parentPath: props.currentPath
                        ? props.currentPath.split("/").slice(0, -1).join("/")
                        : null,
                      entries: props.entries,
                      search: props.query || undefined,
                    },
                  },
                  loading: props.loading,
                  error: props.error,
                  activeId: props.selectedPath ? `file:${props.selectedPath}` : null,
                  dock: "right",
                  narrowLayout: false,
                  onToggleCollapsed: () => {},
                  onSetDock: () => {},
                  onRefresh: () => props.onRefresh(),
                  onBrowsePath: (path) => props.onBrowsePath(path),
                  onOpenFile: (path) => props.onSelect(path),
                  onSearch: (query) => props.onQueryChange(query),
                  onSetFilter: () => {},
                  onOpenArtifact: () => {},
                },
                { embedded: true },
              ),
          root,
        );
        if (previousScroll !== undefined) {
          const generation = scrollRestoreGeneration;
          const next = root.querySelector<HTMLElement>(".chat-workspace-rail__scroll");
          if (next) {
            // A new paint or real user scroll wins over an older deferred
            // restoration. Otherwise rapid tree updates can restore a stale
            // offset after the user has moved the retained Files pane.
            next.addEventListener("scroll", cancelScrollRestore, { once: true });
            pendingScrollRestore = requestAnimationFrame(() => {
              pendingScrollRestore = undefined;
              if (!active || generation !== scrollRestoreGeneration) {
                return;
              }
              next.scrollTop = previousScroll;
            });
          }
        }
      };
      options.signal.throwIfAborted();
      container.append(root);
      paint();
      const dispose = () => {
        if (!active) {
          return;
        }
        cancelScrollRestore();
        active = false;
        render(null, root);
        root.remove();
      };
      options.signal.addEventListener("abort", dispose, { once: true });
      return {
        update(next) {
          if (!active) {
            throw new Error("This plugin component has been disposed.");
          }
          options.signal.throwIfAborted();
          props = next;
          paint();
        },
        dispose,
      };
    },
    mountDialog: (container, props) =>
      mount(
        container,
        props,
        async () => {
          await import("../components/modal-dialog.ts");
          return document.createElement("openclaw-modal-dialog");
        },
        (element, next) => {
          element.label = next.label;
          element.description = next.description ?? "";
          element.className = next.className ?? "";
          element.style.cssText = next.style ?? "";
          if (next.returnFocusTarget !== undefined) {
            element.setReturnFocusTarget(next.returnFocusTarget);
          }
          if (element.firstChild !== next.content) {
            element.replaceChildren(next.content);
          }
        },
        (element, getProps) => {
          const cancel = (event: Event) => {
            if (getProps().onCancel() === false) {
              event.preventDefault();
            }
          };
          element.addEventListener("modal-cancel", cancel);
          return () => element.removeEventListener("modal-cancel", cancel);
        },
      ),
    mountAgentPicker: (container, props) =>
      mount(
        container,
        props,
        async () => {
          await import("../components/agent-select-registration.ts");
          return document.createElement("openclaw-agent-select");
        },
        (element, next, current) => {
          const agents = current().agents.state.agentsList?.agents ?? [];
          element.options = next.options.map((option) => ({
            ...option,
            agent: agents.find((agent) => agent.id === option.agent?.id) ?? option.agent,
            icon: option.icon ? icons[option.icon] : undefined,
          }));
          element.value = next.value;
          element.placeholder = next.placeholder ?? "";
          element.accessibleLabel = next.accessibleLabel;
          element.menuLabel = next.menuLabel ?? "";
          element.disabled = next.disabled ?? false;
          element.onSelect = (value) => {
            current();
            next.onSelect(value);
          };
        },
      ),
    mountDashboard: (container, props) =>
      mount(
        container,
        props,
        async () => {
          await import("./control-ui-dashboard.ts");
          return document.createElement("openclaw-plugin-session-dashboard");
        },
        (element, next, current) => {
          const snapshot = current().gateway.snapshot;
          const access = readGatewayOperatorAccess(snapshot);
          element.session = next.session;
          element.client = snapshot.client;
          element.connected = snapshot.phase === "connected";
          element.canMutate = next.canMutate && access.canWrite;
          element.canGrant = next.canGrant && access.canGrantApprovals;
          element.presented = next.presented ?? true;
        },
      ),
  };
}
