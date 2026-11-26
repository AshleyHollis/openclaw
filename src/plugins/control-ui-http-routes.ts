/** Browser relays accept canonical exact POST paths within their plugin's namespace. */
export function isControlUiHttpRoute(pluginId: string, value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    /^[a-zA-Z0-9_-]+$/u.test(pluginId) &&
    value.startsWith(`/plugins/${pluginId}/`) &&
    /^\/plugins\/[a-zA-Z0-9_-]+\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/u.test(value)
  );
}
