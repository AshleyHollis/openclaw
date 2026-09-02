const notificationId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type PluginNotificationNavigation = {
  kind: "plugin-detail";
  pluginId: string;
  tabId: string;
  destinationId: string;
  recordId: string;
};

export function pluginNotificationNavigationFromSearch(
  search: string | undefined,
  pluginId: string,
  tabId: string,
): PluginNotificationNavigation | undefined {
  const params = new URLSearchParams(search);
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
