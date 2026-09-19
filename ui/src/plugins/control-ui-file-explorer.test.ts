/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createControlUiComponents } from "./control-ui-components.ts";

it("mounts nested explicit empty directories at their declared tree path", () => {
  const lifetime = new AbortController();
  const container = document.createElement("div");
  const components = createControlUiComponents({
    current: () => {
      throw new Error("The file explorer does not require application context.");
    },
    signal: lifetime.signal,
    onError: vi.fn(),
  });

  const handle = components.mountFileExplorer(container, {
    rootLabel: "Topic",
    currentPath: "",
    query: "",
    entries: [{ path: "topics/alpha", name: "alpha", kind: "directory" }],
    selectedPath: null,
    expandedPaths: ["topics", "topics/alpha"],
    loading: false,
    error: null,
    onBrowsePath: vi.fn(),
    onSelect: vi.fn(),
    onQueryChange: vi.fn(),
    onRefresh: vi.fn(),
    onExpandedPathsChange: vi.fn(),
  });

  expect(
    [...container.querySelectorAll<HTMLElement>("summary[data-tree-path]")].map(
      (summary) => summary.dataset.treePath,
    ),
  ).toEqual(["topics", "topics/alpha"]);

  handle.dispose();
  lifetime.abort();
});
