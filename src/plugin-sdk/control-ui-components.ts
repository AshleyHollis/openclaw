import type { BoardGetParams } from "@openclaw/gateway-protocol";

/** Semantic host components available to native Control UI plugins. */
export type ControlUiComponentHandle<T> = {
  update: (props: T) => void;
  dispose: () => void;
};

export type ControlUiDialogProps = {
  label: string;
  description?: string;
  className?: string;
  style?: string;
  /** The plugin retains rendering ownership of this node. */
  content: HTMLElement;
  returnFocusTarget?: HTMLElement | null;
  /** Returning false keeps the dialog open, for example during a pending save. */
  onCancel: () => boolean | void;
};

export type ControlUiAgentPickerProps = {
  options: readonly {
    value: string;
    label: string;
    description?: string;
    badge?: string;
    disabled?: boolean;
    agent?: { id: string };
    icon?: "bot" | "users";
  }[];
  value: string;
  placeholder?: string;
  accessibleLabel: string;
  menuLabel?: string;
  disabled?: boolean;
  onSelect: (value: string) => void;
};

export type ControlUiDashboardProps = {
  session: BoardGetParams;
  canMutate: boolean;
  canGrant: boolean;
  presented?: boolean;
};

/** Presentation-only entries for the host's native Files browser. */
export type ControlUiFileExplorerProps = {
  rootLabel: string;
  currentPath: string;
  query: string;
  entries: readonly {
    path: string;
    name: string;
    kind: "directory" | "file";
    size?: number;
  }[];
  selectedPath: string | null;
  /**
   * When supplied, entries are rendered as a persistent folder tree. The
   * ordinary Session Files caller omits this and retains directory mode.
   */
  expandedPaths?: readonly string[];
  loading: boolean;
  error: string | null;
  onBrowsePath: (path: string) => void;
  onSelect: (path: string) => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  /** Reports the user's persistent tree expansion preference, if tree mode is enabled. */
  onExpandedPathsChange?: (paths: readonly string[]) => void;
};

export type ControlUiComponents = {
  mountFileExplorer: (
    container: HTMLElement,
    props: ControlUiFileExplorerProps,
  ) => ControlUiComponentHandle<ControlUiFileExplorerProps>;
  mountDialog: (
    container: HTMLElement,
    props: ControlUiDialogProps,
  ) => ControlUiComponentHandle<ControlUiDialogProps>;
  mountAgentPicker: (
    container: HTMLElement,
    props: ControlUiAgentPickerProps,
  ) => ControlUiComponentHandle<ControlUiAgentPickerProps>;
  mountDashboard: (
    container: HTMLElement,
    props: ControlUiDashboardProps,
  ) => ControlUiComponentHandle<ControlUiDashboardProps>;
};
