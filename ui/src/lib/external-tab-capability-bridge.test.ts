import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_TAB_BRIDGE_LIMITS,
  ExternalTabCapabilityBridgeController,
} from "./external-tab-capability-bridge.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
      linkedSessionKeys: ["agent:main:host-only"],
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
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("returns an explicit public ready envelope and injects exact linked search keys", async () => {
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

  it("keeps links frozen after create, maps send ids, and blocks escalation", async () => {
    const { port, request } = makeBridge({ links: ["agent:work:owned"] });
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
    expect(request).toHaveBeenCalledWith("sessions.create", {
      agentId: "work",
      label: "New",
      key: "agent:work:dashboard:bridge-create",
    });
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "send",
      operationId: "op",
      method: "chat.send",
      params: { sessionKey: "agent:work:created", message: "hello" },
    });
    expect(await next(port)).toMatchObject({ error: { code: "SESSION_NOT_LINKED" } });
    expect(request).toHaveBeenCalledTimes(1);
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "send-owned",
      operationId: "op",
      method: "chat.send",
      params: { sessionKey: "agent:work:owned", message: "hello" },
    });
    await next(port);
    expect(request).toHaveBeenLastCalledWith("chat.send", {
      sessionKey: "agent:work:owned",
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

  it("bounds total attempts", async () => {
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

  it("rejects malformed core schemas before the authoritative gateway request", async () => {
    const { port, request } = makeBridge();
    await hello(port);
    for (const value of [
      {
        type: "openclaw:capability-bridge-request",
        requestId: "create-shape",
        operationId: "create-shape",
        method: "sessions.create",
        params: { agentId: "" },
      },
      {
        type: "openclaw:capability-bridge-request",
        requestId: "history-shape",
        method: "chat.history",
        params: { sessionKey: "agent:main:linked", offset: -1 },
      },
      {
        type: "openclaw:capability-bridge-request",
        requestId: "send-shape",
        operationId: "send-shape",
        method: "chat.send",
        params: { sessionKey: "agent:main:linked", message: "hi", fastMode: "yes" },
      },
    ]) {
      port.postMessage(value);
      expect(await next(port)).toMatchObject({ error: { code: "INVALID_PARAMS" } });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("caps downstream responses before they reach the iframe", async () => {
    const { port, request } = makeBridge();
    request.mockResolvedValueOnce({
      value: "x".repeat(EXTERNAL_TAB_BRIDGE_LIMITS.maxResponseBytes),
    });
    await hello(port);
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "large-response",
      method: "chat.history",
      params: { sessionKey: "agent:main:linked" },
    });
    expect(await next(port)).toMatchObject({
      requestId: "large-response",
      error: { code: "RESULT_TOO_LARGE" },
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("reconciles a timed-out session creation by logical operation id without a second write", async () => {
    vi.useFakeTimers();
    const pending = deferred<unknown>();
    const request = vi.fn(() => pending.promise);
    const { port } = makeBridge({ request });
    await hello(port);
    const response = next(port);
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "timed-create",
      operationId: "create-operation",
      method: "sessions.create",
      params: { agentId: "work" },
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(EXTERNAL_TAB_BRIDGE_LIMITS.requestTimeoutMs);
    expect(await response).toMatchObject({
      error: { code: "MUTATION_OUTCOME_UNKNOWN", retryable: false },
    });
    const retry = next(port);
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "timed-create-retry",
      operationId: "create-operation",
      method: "sessions.create",
      params: { agentId: "work" },
    });
    pending.resolve({ key: "agent:work:created" });
    expect(await retry).toMatchObject({ result: { key: "agent:work:created" } });
    expect(request).toHaveBeenCalledOnce();
  });

  it("reuses every granted mutation result across transport request ids", async () => {
    const { port, request } = makeBridge({
      methods: ["sessions.create", "plugin.example.write"],
      reads: [],
    });
    await hello(port);
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "create-one",
      operationId: "create-operation",
      method: "sessions.create",
      params: { agentId: "work", label: "Draft" },
    });
    expect(await next(port)).toMatchObject({
      result: {
        agentId: "work",
        label: "Draft",
        key: "agent:work:dashboard:bridge-create-operation",
      },
    });
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "create-two",
      operationId: "create-operation",
      method: "sessions.create",
      params: { agentId: "work", label: "Draft" },
    });
    expect(await next(port)).toMatchObject({
      result: {
        agentId: "work",
        label: "Draft",
        key: "agent:work:dashboard:bridge-create-operation",
      },
    });
    expect(request).toHaveBeenCalledTimes(1);

    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "plugin-one",
      operationId: "plugin-operation",
      method: "plugin.example.write",
      params: { enabled: true },
    });
    await next(port);
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "plugin-two",
      operationId: "plugin-operation",
      method: "plugin.example.write",
      params: { enabled: true },
    });
    await next(port);
    expect(request).toHaveBeenCalledTimes(2);

    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "conflict",
      operationId: "plugin-operation",
      method: "plugin.example.write",
      params: { enabled: false },
    });
    expect(await next(port)).toMatchObject({ error: { code: "OPERATION_CONFLICT" } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("uses the same authoritative session key when an operation is retried on a new bridge", async () => {
    const request = vi.fn(async (_method: string, params: unknown) => params);
    const first = makeBridge({ methods: ["sessions.create"], reads: [], request });
    await hello(first.port);
    first.port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "first-request",
      operationId: "stable-session-create",
      method: "sessions.create",
      params: { agentId: "work" },
    });
    await next(first.port);
    first.controller.revoke();

    const second = makeBridge({ methods: ["sessions.create"], reads: [], request });
    await hello(second.port);
    second.port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "second-request",
      operationId: "stable-session-create",
      method: "sessions.create",
      params: { agentId: "work" },
    });
    await next(second.port);

    expect(request).toHaveBeenNthCalledWith(1, "sessions.create", {
      agentId: "work",
      key: "agent:work:dashboard:bridge-stable-session-create",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.create", {
      agentId: "work",
      key: "agent:work:dashboard:bridge-stable-session-create",
    });
  });

  it("limits concurrent requests without issuing the rejected operation", async () => {
    const operations = Array.from(
      { length: EXTERNAL_TAB_BRIDGE_LIMITS.maxConcurrentRequests },
      () => deferred<unknown>(),
    );
    let operationIndex = 0;
    const request = vi.fn(() => operations[operationIndex++]!.promise);
    const { port } = makeBridge({ request });
    await hello(port);
    for (let index = 0; index < EXTERNAL_TAB_BRIDGE_LIMITS.maxConcurrentRequests; index += 1) {
      port.postMessage({
        type: "openclaw:capability-bridge-request",
        requestId: `active-${index}`,
        method: "chat.history",
        params: { sessionKey: "agent:main:linked" },
      });
    }
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(8));
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "active-overflow",
      method: "chat.history",
      params: { sessionKey: "agent:main:linked" },
    });
    expect(await next(port)).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(request).toHaveBeenCalledTimes(8);
    for (const operation of operations) operation.resolve({ messages: [] });
  });

  it("limits mutations before their authoritative effects", async () => {
    const { port, request } = makeBridge({
      methods: ["chat.send"],
      reads: [],
    });
    await hello(port);
    for (let index = 0; index < EXTERNAL_TAB_BRIDGE_LIMITS.maxMutationsPerMinute; index += 1) {
      port.postMessage({
        type: "openclaw:capability-bridge-request",
        requestId: `mutation-${index}`,
        operationId: `operation-${index}`,
        method: "chat.send",
        params: { sessionKey: "agent:main:linked", message: "hello" },
      });
      await next(port);
    }
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "mutation-overflow",
      operationId: "operation-overflow",
      method: "chat.send",
      params: { sessionKey: "agent:main:linked", message: "hello" },
    });
    expect(await next(port)).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(request).toHaveBeenCalledTimes(EXTERNAL_TAB_BRIDGE_LIMITS.maxMutationsPerMinute);
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
