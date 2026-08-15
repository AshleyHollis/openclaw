import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_TAB_BRIDGE_LIMITS,
  ExternalTabCapabilityBridgeController,
} from "./external-tab-capability-bridge.ts";

function makeBridge(
  params: {
    methods?: string[];
    reads?: string[];
    links?: string[];
    now?: () => number;
    request?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const ports: MessagePort[] = [];
  const frame = {
    contentWindow: {
      postMessage: (_value: unknown, _origin: string, transferred: MessagePort[]) =>
        ports.push(transferred[0]!),
    },
  } as unknown as HTMLIFrameElement;
  const request = params.request ?? vi.fn(async (_method: string, values: unknown) => values);
  const controller = new ExternalTabCapabilityBridgeController({
    frame,
    client: { request },
    linkedSessionKeys: params.links ?? ["agent:main:linked"],
    navigate: vi.fn(),
    now: params.now,
    grant: {
      protocolVersion: 1,
      mode: "read-write",
      methods: params.methods ?? [
        "chat.history",
        "sessions.search",
        "chat.send",
        "sessions.create",
        "ui.session.navigate",
      ],
      readMethods: params.reads ?? ["chat.history", "sessions.search", "ui.session.navigate"],
      missingRequiredMethods: [],
      upgradeRequired: false,
    },
  });
  controller.connect();
  const port = ports[0]!;
  port.start();
  return { controller, port, request };
}
function next(port: MessagePort) {
  return new Promise<Record<string, unknown>>((resolve) => {
    port.onmessage = (event) => resolve(event.data as Record<string, unknown>);
  });
}
async function hello(port: MessagePort) {
  port.postMessage({ type: "openclaw:capability-bridge-hello", protocolVersion: 1 });
  return await next(port);
}

describe("ExternalTabCapabilityBridgeController", () => {
  afterEach(() => vi.restoreAllMocks());
  it("returns only the public ready envelope and injects exact linked search keys", async () => {
    const { port, request } = makeBridge();
    expect(await hello(port)).toEqual({
      type: "openclaw:capability-bridge-ready",
      protocolVersion: 1,
      mode: "read-write",
      methods: [
        "chat.history",
        "sessions.search",
        "chat.send",
        "sessions.create",
        "ui.session.navigate",
      ],
      missingRequiredMethods: [],
      upgradeRequired: false,
      limits: EXTERNAL_TAB_BRIDGE_LIMITS,
    });
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "search",
      method: "sessions.search",
      params: { query: "x" },
    });
    await next(port);
    expect(request).toHaveBeenCalledWith("sessions.search", {
      query: "x",
      limit: 25,
      sessionKeys: ["agent:main:linked"],
      agentId: "main",
    });
  });

  it("rejects ungranted, unlinked, extra, and oversized requests before dispatch", async () => {
    const { port, request } = makeBridge();
    await hello(port);
    for (const value of [
      {
        type: "openclaw:capability-bridge-request",
        requestId: "list",
        method: "sessions.list",
        params: {},
      },
      {
        type: "openclaw:capability-bridge-request",
        requestId: "unlinked",
        method: "chat.history",
        params: { sessionKey: "agent:main:no" },
      },
      {
        type: "openclaw:capability-bridge-request",
        requestId: "extra",
        method: "chat.history",
        params: { sessionKey: "agent:main:linked" },
        extra: true,
      },
      {
        type: "openclaw:capability-bridge-request",
        requestId: "large",
        method: "chat.history",
        params: {
          sessionKey: "agent:main:linked",
          padding: "x".repeat(EXTERNAL_TAB_BRIDGE_LIMITS.maxRequestBytes),
        },
      },
    ]) {
      port.postMessage(value);
      expect((await next(port)).error).toBeDefined();
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("links a created session, maps stable send operation ids, and blocks create escalation fields", async () => {
    const { port, request } = makeBridge({ links: [] });
    request.mockResolvedValueOnce({ key: "agent:work:created" });
    await hello(port);
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "bad-create",
      operationId: "bad",
      method: "sessions.create",
      params: { agentId: "work", cwd: "/x" },
    });
    expect((await next(port)).error).toBeDefined();
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "create",
      operationId: "create",
      method: "sessions.create",
      params: { agentId: "work", label: "New" },
    });
    await next(port);
    expect(request).toHaveBeenCalledWith("sessions.create", { agentId: "work", label: "New" });
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "send",
      operationId: "op",
      method: "chat.send",
      params: { sessionKey: "agent:work:created", message: "hello" },
    });
    await next(port);
    expect(request).toHaveBeenLastCalledWith("chat.send", {
      sessionKey: "agent:work:created",
      message: "hello",
      idempotencyKey: "op",
    });
  });

  it("returns local empty search and partitions multiple agents", async () => {
    const empty = makeBridge({ links: [] });
    await hello(empty.port);
    empty.port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "empty",
      method: "sessions.search",
      params: { query: "x" },
    });
    expect(await next(empty.port)).toMatchObject({ result: { results: [] } });
    expect(empty.request).not.toHaveBeenCalled();
    const multi = makeBridge({ links: ["agent:main:a", "agent:work:b"] });
    await hello(multi.port);
    multi.port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "multi",
      method: "sessions.search",
      params: { query: "x" },
    });
    await next(multi.port);
    expect(multi.request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({ agentId: "main", sessionKeys: ["agent:main:a"] }),
    );
    expect(multi.request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({ agentId: "work", sessionKeys: ["agent:work:b"] }),
    );
  });

  it("bounds total, mutation, and concurrent attempts", async () => {
    let now = 0;
    const { port } = makeBridge({ now: () => now });
    await hello(port);
    for (let index = 0; index < 60; index += 1) {
      port.postMessage({
        type: "openclaw:capability-bridge-request",
        requestId: `d-${index}`,
        method: "sessions.list",
        params: {},
      });
      await next(port);
    }
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "d-60",
      method: "sessions.list",
      params: {},
    });
    expect(await next(port)).toMatchObject({ error: { code: "RATE_LIMITED" } });
    now = 60_001;
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "d-60",
      method: "sessions.list",
      params: {},
    });
    expect(await next(port)).toMatchObject({ error: { code: "METHOD_NOT_GRANTED" } });
  });

  it("does not expose downstream error text", async () => {
    const { port, request } = makeBridge();
    request.mockRejectedValueOnce(new Error("Gateway token should not cross"));
    await hello(port);
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "err",
      method: "chat.history",
      params: { sessionKey: "agent:main:linked" },
    });
    expect(await next(port)).toMatchObject({
      error: { code: "INVALID_PARAMS", message: "Gateway rejected bridge request" },
    });
  });
});
