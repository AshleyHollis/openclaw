import type {
  ControlUiHttpRequest,
  ControlUiHttpResponse,
} from "../../../src/plugin-sdk/control-ui.js";
import {
  CONTROL_UI_HTTP_RELAY_HEADER,
  type ControlUiHttpRelayRoute,
} from "../../../src/shared/control-ui-http-relay.js";

/** Host-only transport: credentials never enter the plugin's request or response envelope. */
export async function requestControlUiHttp(
  routes: readonly ControlUiHttpRelayRoute[],
  request: ControlUiHttpRequest,
  authorization: string | null,
  signal: AbortSignal,
): Promise<ControlUiHttpResponse> {
  signal.throwIfAborted();
  const route = routes.find(
    (route) => route.method === request.method && route.path === request.path,
  );
  if (
    !route ||
    Object.keys(request).some(
      (key) =>
        !(request.method === "POST" ? ["method", "path", "body"] : ["method", "path"]).includes(
          key,
        ),
    )
  ) {
    throw new Error("This plugin HTTP route is not declared.");
  }
  const body = request.method === "POST" ? request.body : undefined;
  if (request.method === "POST") {
    if (
      typeof body !== "string" ||
      new TextEncoder().encode(body).byteLength > route.maxRequestBytes
    ) {
      throw new Error("Plugin HTTP request exceeds its declared body limit.");
    }
    try {
      JSON.parse(body);
    } catch {
      throw new Error("Plugin HTTP requires a JSON body.");
    }
  }
  const url = new URL(route.path, window.location.origin);
  try {
    const response = await fetch(url, {
      method: route.method,
      headers: {
        Accept: "application/json",
        [CONTROL_UI_HTTP_RELAY_HEADER]: "1",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(authorization ? { Authorization: authorization } : {}),
      },
      credentials: "omit",
      redirect: "error",
      signal,
      ...(body === undefined ? {} : { body }),
    });
    if (
      response.redirected ||
      (response.url && response.url !== url.href) ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Invalid plugin HTTP response.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing plugin HTTP response.");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > route.maxResponseBytes)
          throw new Error("Plugin HTTP response exceeds its declared limit.");
        text += decoder.decode(part.value, { stream: true });
      }
      signal.throwIfAborted();
      text += decoder.decode();
      JSON.parse(text);
      return { status: response.status, body: text };
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch {
    // Network errors can contain request metadata. Writes may already have committed.
    throw new Error(
      request.method === "POST"
        ? "Plugin HTTP write outcome is unknown. Reconcile the operation before retrying."
        : "Plugin HTTP read did not complete. Refresh the current view.",
    );
  }
}
