import type { ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { SidebarZoneEntry } from "../app-navigation.ts";
import type { ControlUiRegistration } from "../plugins/control-ui-capability.ts";

export type SidebarPluginNavigationGroup = {
  key: string;
  label: string;
  entries: SidebarZoneEntry[];
};

export function buildPluginNavigationGroups(
  entries: readonly SidebarZoneEntry[],
  navigation: readonly ControlUiRegistration<ControlUiNavigationItem>[],
) {
  const navigationByKey = new Map<string, ControlUiRegistration<ControlUiNavigationItem>>(
    navigation.map((entry) => [entry.key, entry]),
  );
  const navigationGroups = new Map<string, SidebarPluginNavigationGroup>();
  const groupedNavigationKeys = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "plugin") {
      continue;
    }
    const registration = navigationByKey.get(entry.key);
    const group = registration?.value.group;
    if (!registration || !group?.id.trim() || !group.label.trim()) {
      continue;
    }
    const key = JSON.stringify([registration.pluginId, group.id]);
    let section = navigationGroups.get(key);
    if (!section) {
      section = { key, label: group.label, entries: [] };
      navigationGroups.set(key, section);
    }
    section.entries.push(entry);
    groupedNavigationKeys.add(entry.key);
  }
  return { navigationGroups: [...navigationGroups.values()], groupedNavigationKeys };
}

export function isUngroupedSidebarEntry(
  entry: SidebarZoneEntry,
  groupedNavigationKeys: ReadonlySet<string>,
) {
  return (
    entry.type !== "session" && !(entry.type === "plugin" && groupedNavigationKeys.has(entry.key))
  );
}
