/** Browser-only contract for trusted native Control UI plugins. No host implementation imports. */
import type {
  AgentSummary,
  BoardGetParams,
  SessionRow,
  SessionsListParams,
} from "@openclaw/gateway-protocol";
import type { ControlUiComponents } from "./control-ui-components.js";
export type {
  ControlUiAgentPickerProps,
  ControlUiComponentHandle,
  ControlUiComponents,
  ControlUiDashboardProps,
  ControlUiDialogProps,
} from "./control-ui-components.js";
export type ControlUiDisposer = () => void;

export type ControlUiConnection = {
  connected: boolean;
  canRead: boolean;
  canWrite: boolean;
  canGrant: boolean;
  canAdmin: boolean;
  assistantAgentId: string | null;
};

export type ControlUiSession = Readonly<
  SessionRow & {
    /** Live activity from the Control UI session owner; absent while activity is unknown. */
    hasActiveRun?: boolean;
  }
>;

export type ControlUiSessionListQuery = Readonly<
  Pick<
    SessionsListParams,
    | "agentId"
    | "search"
    | "archived"
    | "limit"
    | "configuredAgentsOnly"
    | "includeGlobal"
    | "includeUnknown"
    | "includeDerivedTitles"
    | "includeLastMessage"
  >
>;

export type ControlUiSessionListResult = {
  readonly sessions: readonly ControlUiSession[];
  readonly hasMore?: boolean;
  readonly nextOffset?: number | null;
  readonly totalCount?: number;
};

export type ControlUiSessionListSnapshot = {
  readonly result: ControlUiSessionListResult | null;
  readonly loading: boolean;
  readonly error: string | null;
};

export type ControlUiSessionListSubscription = {
  /** Fetch again; rejects on failure or when this query's lifetime has ended. */
  refresh: () => Promise<void>;
  dispose: ControlUiDisposer;
};

export type ControlUiAgent = Readonly<AgentSummary>;
export type ControlUiPageTarget = {
  id: string;
  params?: Readonly<Record<string, string>>;
  /** Unescaped path segments for a page with an advertised native route placement. */
  path?: readonly string[];
};
export type ControlUiPageNavigationOptions = {
  /** Replace the current history entry when canonicalizing a page or changing its filters. */
  replace?: boolean;
  /** Retain the current query, with target parameters taking precedence. */
  preserveSearch?: boolean;
};

export type ControlUiSurfaceProps = {
  "session-list": BoardGetParams & { sessions: readonly ControlUiSession[] };
  composer: BoardGetParams & {
    agentId: string;
    draft: string;
    canSend: boolean;
    sending: boolean;
    disabledReason: string | null;
    setDraft: (text: string) => void;
    /** Resolves true on admission, false on rejection, or void for a local command/no submit. */
    send: () => Promise<boolean | void>;
    abort?: () => void;
  };
  workspace: BoardGetParams & { routeId: string };
  transcript: BoardGetParams & {
    messages: readonly unknown[];
    stream: string | null;
    loading: boolean;
  };
  "tool-result": BoardGetParams & {
    toolName: string;
    toolCallId: string;
    input: unknown;
    output: unknown;
    expanded: boolean;
  };
};

export type ControlUiSurface = keyof ControlUiSurfaceProps;

export type ControlUiViewContext<T = Readonly<Record<string, string>>, Host = ControlUiHost> = {
  readonly host: Host;
  readonly signal: AbortSignal;
  readonly props: T;
  /** Presentation can pause a retained view without ending its host lifetime. */
  readonly presented: boolean;
  /** Mount the host's built-in view inside a replacement; it keeps receiving host updates. */
  mountDefault: (container: HTMLElement) => ControlUiDisposer;
};

export type ControlUiView<T = Readonly<Record<string, string>>, Host = ControlUiHost> = (
  container: HTMLElement,
  context: ControlUiViewContext<T, Host>,
) => {
  update?: (context: ControlUiViewContext<T, Host>) => void;
  focus?: () => void;
  dispose?: ControlUiDisposer;
} | void;

export type ControlUiPage<Host = ControlUiHost> = {
  id: string;
  label: string;
  mount: ControlUiView<Readonly<Record<string, string>>, Host>;
};

export type ControlUiNavigationItem = {
  id: string;
  label: string;
  page: ControlUiPageTarget;
  icon?: string;
  order?: number;
  /** False offers the destination in the pin editor without adding it to the sidebar. */
  defaultVisible?: boolean;
};

export type ControlUiPanel<Host = ControlUiHost> = {
  id: string;
  label: string;
  mount: ControlUiView<BoardGetParams, Host>;
};

export type ControlUiAction<Host = ControlUiHost> = {
  id: string;
  label: string;
  placement: "composer" | "header" | "session";
  resolve?: (context: BoardGetParams & { session?: ControlUiSession }) => {
    label?: string;
    disabled?: boolean;
    hidden?: boolean;
  };
  run: (
    context: BoardGetParams & {
      session?: ControlUiSession;
      host: Host;
      signal: AbortSignal;
    },
  ) => void | Promise<void>;
};

export type ControlUiAccessory<Host = ControlUiHost> = {
  id: string;
  placement: "session-header";
  mount: ControlUiView<BoardGetParams, Host>;
};

export type ControlUiWidget<Host = ControlUiHost> = {
  id: string;
  label: string;
  mount: ControlUiView<
    BoardGetParams & {
      widget: { name: string; props?: Readonly<Record<string, unknown>> };
      canMutate: boolean;
      canGrant: boolean;
    },
    Host
  >;
};

export type ControlUiReplacement<
  S extends ControlUiSurface = ControlUiSurface,
  Host = ControlUiHost,
> = {
  [Surface in S]: {
    id: string;
    label: string;
    surface: Surface;
    mount: ControlUiView<ControlUiSurfaceProps[Surface], Host>;
  };
}[S];

type ControlUiHostContract<Host> = {
  readonly apiVersion: 1;
  readonly pluginId: string;
  readonly signal: AbortSignal;
  readonly basePath: string;
  readonly locale: string;
  redact: (text: string) => string;
  readonly connection: ControlUiConnection;
  readonly components: ControlUiComponents;
  /**
   * Native modules share the operator's authenticated Gateway authority.
   * The Gateway enforces connection scopes, not a per-plugin RPC allowlist.
   */
  request: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  onEvent: (event: string, listener: (payload: unknown) => void) => ControlUiDisposer;
  subscribe: (listener: () => void) => ControlUiDisposer;
  sessions: {
    /** The current application roster may be filtered and paginated. */
    readonly rows: readonly ControlUiSession[];
    readonly selectedKey: string;
    normalizeKey: (sessionKey: string) => string;
    refresh: () => Promise<void>;
    /** Fetch and observe an independent query; the first snapshot may have no result. */
    observe: (
      query: ControlUiSessionListQuery,
      listener: (snapshot: ControlUiSessionListSnapshot) => void,
    ) => ControlUiSessionListSubscription;
    open: (session: BoardGetParams) => void;
    create: (params?: { agentId?: string; label?: string }) => Promise<string | null>;
    patch: (
      session: BoardGetParams,
      patch: { label?: string; model?: string | null },
    ) => Promise<void>;
  };
  agents: {
    readonly rows: readonly ControlUiAgent[];
    readonly selectedId: string | null;
    readonly defaultId: string | null;
    readonly scopeId: string | null;
    select: (agentId: string) => void;
    setScope: (agentId: string | null) => void;
    refresh: () => Promise<void>;
  };
  navigation: {
    openPage: (target: ControlUiPageTarget, options?: ControlUiPageNavigationOptions) => void;
    pageHref: (
      target: ControlUiPageTarget,
      options?: Pick<ControlUiPageNavigationOptions, "preserveSearch">,
    ) => string;
  };
  ui: {
    /** Refresh contributions whose presentation depends on plugin-owned state. */
    invalidate: () => void;
    registerPage: (page: ControlUiPage<Host>) => ControlUiDisposer;
    registerNavigation: (item: ControlUiNavigationItem) => ControlUiDisposer;
    registerPanel: (panel: ControlUiPanel<Host>) => ControlUiDisposer;
    registerAction: (action: ControlUiAction<Host>) => ControlUiDisposer;
    registerAccessory: (accessory: ControlUiAccessory<Host>) => ControlUiDisposer;
    registerWidget: (widget: ControlUiWidget<Host>) => ControlUiDisposer;
    registerReplacement: (
      replacement: ControlUiReplacement<ControlUiSurface, Host>,
    ) => ControlUiDisposer;
    /** Select an owned replacement, or restore the built-in view for this surface. */
    selectReplacement: (surface: ControlUiSurface, id: string | null) => void;
  };
};

/** Legacy browser contract remains source-compatible throughout the 2026.9 release line. */
export interface ControlUiHost extends ControlUiHostContract<ControlUiHost> {}

export type ControlUiHttpRequest =
  | { method: "GET"; path: string }
  | { method: "POST"; path: string; body: string };
export type ControlUiHttpResponse = { status: number; body: string };

/** Current host authority. Mounted views receive their own lifetime-bound copy. */
export interface ControlUiHostV2 extends ControlUiHostContract<ControlUiHostV2> {
  /** Declared same-origin JSON routes only. Interrupted writes require reconciliation, not retry. */
  httpRequest: (
    request: ControlUiHttpRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<ControlUiHttpResponse>;
}

export type ControlUiPlugin<Host = ControlUiHost> = {
  id: string;
  activate: (host: Host) => void | ControlUiDisposer | Promise<void | ControlUiDisposer>;
};

export type ControlUiPluginV2 = ControlUiPlugin<ControlUiHostV2>;
export type ControlUiViewV2<T = Readonly<Record<string, string>>> = ControlUiView<
  T,
  ControlUiHostV2
>;
export type ControlUiViewContextV2<T = Readonly<Record<string, string>>> = ControlUiViewContext<
  T,
  ControlUiHostV2
>;
export type ControlUiPageV2 = ControlUiPage<ControlUiHostV2>;
export type ControlUiPanelV2 = ControlUiPanel<ControlUiHostV2>;
export type ControlUiActionV2 = ControlUiAction<ControlUiHostV2>;
export type ControlUiAccessoryV2 = ControlUiAccessory<ControlUiHostV2>;
export type ControlUiWidgetV2 = ControlUiWidget<ControlUiHostV2>;
export type ControlUiReplacementV2<S extends ControlUiSurface = ControlUiSurface> =
  ControlUiReplacement<S, ControlUiHostV2>;

export function defineControlUiPlugin(plugin: ControlUiPluginV2): ControlUiPluginV2;
export function defineControlUiPlugin(plugin: ControlUiPlugin): ControlUiPlugin;
export function defineControlUiPlugin(
  plugin: ControlUiPlugin | ControlUiPluginV2,
): ControlUiPlugin | ControlUiPluginV2 {
  return plugin;
}
