/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { ControlUiRegistration } from "../plugins/control-ui-capability.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "../test-helpers/app-sidebar-suite.ts";
import "./app-sidebar.ts";
import "../plugins/control-ui-view.runtime.ts";
import { buildReconciledSidebarZone } from "./app-sidebar-session-navigation-logic.ts";

function navigation(pluginId: string, id: string, grouped = true, defaultVisible = true) {
  return {
    key: `${pluginId}/${id}`,
    pluginId,
    signal: new AbortController().signal,
    value: {
      id,
      label: id,
      page: { id },
      defaultVisible,
      ...(grouped ? { group: { id: "workspace", label: `${pluginId} workspace` } } : {}),
    },
    host: { navigation: { pageHref: () => `/plugins/${pluginId}/${id}`, openPage: vi.fn() } },
  } as unknown as ControlUiRegistration<ControlUiNavigationItem>;
}

it("groups only visible navigation, with plugin-scoped identity and stable member order", () => {
  const entries = [
    navigation("one", "dashboard"),
    navigation("one", "planner"),
    navigation("two", "dashboard"),
    navigation("one", "optional", true, false),
    navigation("one", "plain", false),
  ];
  const result = buildReconciledSidebarZone({
    sidebarEntries: ["plugin:one/planner"],
    rows: [],
    pluginNavigation: entries,
    pluginTabs: [],
  });
  expect(
    result.navigationGroups.map((group) => [
      group.label,
      group.entries.map((entry) => ("key" in entry ? entry.key : "")),
    ]),
  ).toEqual([
    ["one workspace", ["one/planner", "one/dashboard"]],
    ["two workspace", ["two/dashboard"]],
  ]);
  expect([...result.groupedNavigationKeys]).toEqual([
    "one/planner",
    "one/dashboard",
    "two/dashboard",
  ]);
});

it("renders one disclosure outside tools, preserves sessions, navigation and collapse through refresh", async () => {
  const sessions = createSessionsHarness("main", ["agent:main:main", "agent:main:example"]);
  const { sidebar, context } = await mountSidebar(
    createGateway(createTestGatewayClient(async () => ({}))),
    sessions.sessions,
  );
  const entries = [
    navigation("example", "dashboard"),
    navigation("example", "planner"),
    navigation("example", "plain", false),
  ];
  Object.assign(context, {
    plugins: {
      registrations: (kind: string) => (kind === "navigation" ? entries : []),
      selectedReplacement: () => undefined,
      subscribe: () => () => {},
    },
  });
  sidebar.requestUpdate();
  await waitForFast(() =>
    expect(sidebar.querySelectorAll(".sidebar-nav__plugin-group a")).toHaveLength(2),
  );
  const group = sidebar.querySelector<HTMLDetailsElement>(".sidebar-nav__plugin-group")!;
  expect(group.querySelector("summary")?.textContent?.trim()).toBe("example workspace");
  expect(sidebar.querySelectorAll('[data-sidebar-entry="plugin:example/dashboard"]')).toHaveLength(
    1,
  );
  expect(
    group
      .querySelector('[data-sidebar-entry="plugin:example/dashboard"]')
      ?.getAttribute("draggable"),
  ).toBe("false");
  expect(group.querySelector(".sidebar-session-content")).toBeNull();
  expect(sidebar.querySelector(".sidebar-session-content")).not.toBeNull();
  group.querySelector<HTMLAnchorElement>("a")!.click();
  expect(entries[0].host.navigation.openPage).toHaveBeenCalledWith({ id: "dashboard" });
  group.open = false;
  sidebar.requestUpdate();
  await sidebar.updateComplete;
  expect(sidebar.querySelector(".sidebar-nav__plugin-group")).toBe(group);
  expect(group.open).toBe(false);
  entries.splice(0, 2);
  sidebar.requestUpdate();
  await sidebar.updateComplete;
  expect(sidebar.querySelector(".sidebar-nav__plugin-group")).toBeNull();
});
