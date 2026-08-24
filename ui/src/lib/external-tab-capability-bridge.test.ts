import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createExternalTabCapabilityBridgeMutationState,
  EXTERNAL_TAB_BRIDGE_LIMITS,
  ExternalTabCapabilityBridgeController,
  type ExternalTabCapabilityBridgeMutationState,
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
    mutationNamespace?: string;
    mutationState?: ExternalTabCapabilityBridgeMutationState;
    onHandshakeFailure?: Mock<() => void>;
    now?: () => number;
    request?: Mock<(method: string, params?: unknown) => Promise<unknown>>;
  } = {},
) {
  const request = params.request ?? vi.fn(async (_method: string, values: unknown) => values);
  const controller = new ExternalTabCapabilityBridgeController({
    client: { request },
    mutationNamespace: params.mutationNamespace ?? "operator-a-tab-a",
    mutationState: params.mutationState,
    linkedSessionKeys: params.links ?? ["agent:main:linked"],
    navigate: vi.fn(),
    onHandshakeFailure: params.onHandshakeFailure,
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
  const channel = new MessageChannel();
  controller.connect(channel.port1);
  channel.port2.start();
  return { controller, port: channel.port2, request };
}
function next(port: MessagePort) {
  return new Promise<Record<string, unknown>>((resolve) => {
    port.addEventListener("message", (event) => resolve(event.data as Record<string, unknown>), {
      once: true,
    });
  });
}
async function hello(port: MessagePort) {
  port.postMessage({ type: "openclaw:capability-bridge-hello", protocolVersion: 1 }, []);
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
        operationId: "large-operation",
        method: "chat.send",
        params: {
          sessionKey: "agent:main:linked",
          message: "x".repeat(EXTERNAL_TAB_BRIDGE_LIMITS.maxRequestBytes),
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
      key: "agent:work:dashboard:bridge-operator-a-tab-a-create",
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
      operationId: "op-owned",
      method: "chat.send",
      params: { sessionKey: "agent:work:owned", message: "hello" },
    });
    await next(port);
    expect(request).toHaveBeenLastCalledWith("chat.send", {
      sessionKey: "agent:work:owned",
      message: "hello",
      idempotencyKey: "bridge:operator-a-tab-a:op-owned",
    });
  });

  it("returns local empty search and partitions multiple agents", async () => {
    const empty = makeBridge({ links: [] });
    await hello(empty.port);
    empty.port.postMessage(
      {
        type: "openclaw:capability-bridge-request",
        requestId: "empty",
        method: "sessions.search",
        params: { query: "x" },
      },
      [],
    );
    expect(await next(empty.port)).toMatchObject({ result: { results: [] } });
    expect(empty.request).not.toHaveBeenCalled();
    const multi = makeBridge({ links: ["agent:main:a", "agent:work:b"] });
    await hello(multi.port);
    multi.port.postMessage(
      {
        type: "openclaw:capability-bridge-request",
        requestId: "multi",
        method: "sessions.search",
        params: { query: "x" },
      },
      [],
    );
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

  it("searches every linked agent serially without rejecting the declared exact key set", async () => {
    const links = Array.from({ length: 200 }, (_, index) => `agent:agent-${index}:linked`);
    let active = 0;
    let peakActive = 0;
    const request = vi.fn(async (_method: string, _params: unknown) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await Promise.resolve();
      active -= 1;
      return { results: [] };
    });
    const { port } = makeBridge({ links, request });
    await hello(port);
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "many-agents",
      method: "sessions.search",
      params: { query: "x" },
    });
    expect(await next(port)).toMatchObject({ result: { results: [] } });
    expect(request).toHaveBeenCalledTimes(200);
    expect(peakActive).toBe(1);
    expect(
      request.mock.calls.flatMap(
        ([, params]) => (params as { sessionKeys?: string[] }).sessionKeys ?? [],
      ),
    ).toEqual(links);
  });

  it("globally ranks linked-agent search results and preserves truncation", async () => {
    const { port, request } = makeBridge({
      links: ["agent:main:lower", "agent:work:higher"],
      request: vi
        .fn()
        .mockResolvedValueOnce({
          results: [{ sessionKey: "agent:main:lower", score: 1, timestamp: 100 }],
        })
        .mockResolvedValueOnce({
          results: [{ sessionKey: "agent:work:higher", score: 9, timestamp: 50 }],
          truncated: true,
        }),
    });
    await hello(port);
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "ranked",
      method: "sessions.search",
      params: { query: "x", limit: 1 },
    });
    expect(await next(port)).toMatchObject({
      result: {
        results: [{ sessionKey: "agent:work:higher", score: 9, timestamp: 50 }],
        truncated: true,
      },
    });
    expect(request).toHaveBeenCalledTimes(2);
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
        key: "agent:work:dashboard:bridge-operator-a-tab-a-create-operation",
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
        key: "agent:work:dashboard:bridge-operator-a-tab-a-create-operation",
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

  it("reuses a host mutation identity only within the same tab authority", async () => {
    const request = vi.fn(async (_method: string, params: unknown) => params);
    const mutationState = createExternalTabCapabilityBridgeMutationState();
    const first = makeBridge({
      methods: ["sessions.create"],
      reads: [],
      request,
      mutationNamespace: "operator-a-tab-a",
      mutationState,
    });
    await hello(first.port);
    first.port.postMessage(
      {
        type: "openclaw:capability-bridge-request",
        requestId: "first-request",
        operationId: "stable-session-create",
        method: "sessions.create",
        params: { agentId: "work" },
      },
      [],
    );
    await next(first.port);
    first.controller.revoke();

    const second = makeBridge({
      methods: ["sessions.create"],
      reads: [],
      request,
      mutationNamespace: "operator-a-tab-a",
      mutationState,
    });
    await hello(second.port);
    second.port.postMessage(
      {
        type: "openclaw:capability-bridge-request",
        requestId: "second-request",
        operationId: "stable-session-create",
        method: "sessions.create",
        params: { agentId: "work" },
      },
      [],
    );
    await next(second.port);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("sessions.create", {
      agentId: "work",
      key: "agent:work:dashboard:bridge-operator-a-tab-a-stable-session-create",
    });
  });

  it("reconciles a plugin write after the private transport remounts", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn(() => pending.promise);
    const mutationState = createExternalTabCapabilityBridgeMutationState();
    const first = makeBridge({
      methods: ["plugin.example.write"],
      reads: [],
      mutationState,
      request,
    });
    await hello(first.port);
    first.port.postMessage(
      {
        type: "openclaw:capability-bridge-request",
        requestId: "first-transport",
        operationId: "stable-write",
        method: "plugin.example.write",
        params: { enabled: true },
      },
      [],
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    first.controller.revoke();

    const second = makeBridge({
      methods: ["plugin.example.write"],
      reads: [],
      mutationState,
      request,
    });
    await hello(second.port);
    const retry = next(second.port);
    second.port.postMessage(
      {
        type: "openclaw:capability-bridge-request",
        requestId: "second-transport",
        operationId: "stable-write",
        method: "plugin.example.write",
        params: { enabled: true },
      },
      [],
    );
    pending.resolve({ applied: true });
    expect(await retry).toMatchObject({ result: { applied: true } });
    expect(request).toHaveBeenCalledOnce();
  });

  it("refuses an ambiguous plugin-write retry after its durable ledger is rehydrated", async () => {
    const request = vi.fn(() => new Promise<unknown>(() => {}));
    const firstState = createExternalTabCapabilityBridgeMutationState();
    const first = makeBridge({
      methods: ["plugin.example.write"],
      reads: [],
      mutationState: firstState,
      request,
    });
    await hello(first.port);
    first.port.postMessage(
      {
        type: "openclaw:capability-bridge-request",
        requestId: "first-page",
        operationId: "stable-write",
        method: "plugin.example.write",
        params: { enabled: true },
      },
      [],
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    first.controller.revoke();

    const second = makeBridge({
      methods: ["plugin.example.write"],
      reads: [],
      mutationState: createExternalTabCapabilityBridgeMutationState({
        tombstones: firstState.tombstones,
      }),
      request,
    });
    await hello(second.port);
    second.port.postMessage(
      {
        type: "openclaw:capability-bridge-request",
        requestId: "reloaded-page",
        operationId: "stable-write",
        method: "plugin.example.write",
        params: { enabled: true },
      },
      [],
    );
    expect(await next(second.port)).toMatchObject({
      error: { code: "MUTATION_RECONCILIATION_REQUIRED", retryable: false },
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("partitions identical logical writes across authenticated tab authorities", async () => {
    const request = vi.fn(async (_method: string, params: unknown) => params);
    const first = makeBridge({
      methods: ["sessions.create", "chat.send"],
      reads: [],
      request,
      mutationNamespace: "operator-a-tab-a",
    });
    const second = makeBridge({
      methods: ["sessions.create", "chat.send"],
      reads: [],
      request,
      mutationNamespace: "operator-b-tab-b",
    });
    await Promise.all([hello(first.port), hello(second.port)]);

    for (const bridge of [first, second]) {
      bridge.port.postMessage(
        {
          type: "openclaw:capability-bridge-request",
          requestId: `create-${bridge === first ? "a" : "b"}`,
          operationId: "create",
          method: "sessions.create",
          params: { agentId: "work" },
        },
        [],
      );
      await next(bridge.port);
      bridge.port.postMessage(
        {
          type: "openclaw:capability-bridge-request",
          requestId: `send-${bridge === first ? "a" : "b"}`,
          operationId: "send",
          method: "chat.send",
          params: { sessionKey: "agent:main:linked", message: "hello" },
        },
        [],
      );
      await next(bridge.port);
    }

    expect(request).toHaveBeenNthCalledWith(1, "sessions.create", {
      agentId: "work",
      key: "agent:work:dashboard:bridge-operator-a-tab-a-create",
    });
    expect(request).toHaveBeenNthCalledWith(2, "chat.send", {
      sessionKey: "agent:main:linked",
      message: "hello",
      idempotencyKey: "bridge:operator-a-tab-a:send",
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.create", {
      agentId: "work",
      key: "agent:work:dashboard:bridge-operator-b-tab-b-create",
    });
    expect(request).toHaveBeenNthCalledWith(4, "chat.send", {
      sessionKey: "agent:main:linked",
      message: "hello",
      idempotencyKey: "bridge:operator-b-tab-b:send",
    });
  });

  it("reports an absent or incompatible handshake to the mounting page", async () => {
    vi.useFakeTimers();
    const absent = vi.fn();
    makeBridge({ onHandshakeFailure: absent });
    await vi.advanceTimersByTimeAsync(EXTERNAL_TAB_BRIDGE_LIMITS.handshakeTimeoutMs);
    expect(absent).toHaveBeenCalledOnce();
    vi.useRealTimers();

    const incompatible = vi.fn();
    const bridge = makeBridge({ onHandshakeFailure: incompatible });
    bridge.port.postMessage({ type: "openclaw:capability-bridge-hello", protocolVersion: 2 }, []);
    await vi.waitFor(() => expect(incompatible).toHaveBeenCalledOnce());
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
    for (const operation of operations) {
      operation.resolve({ messages: [] });
    }
  });

  it("keeps timed-out Gateway work inside the downstream concurrency limit", async () => {
    vi.useFakeTimers();
    const operations = Array.from(
      { length: EXTERNAL_TAB_BRIDGE_LIMITS.maxConcurrentRequests + 1 },
      () => deferred<unknown>(),
    );
    let operationIndex = 0;
    const request = vi.fn(() => operations[operationIndex++]!.promise);
    const { port } = makeBridge({ request });
    const responses: Record<string, unknown>[] = [];
    port.addEventListener("message", (event) =>
      responses.push(event.data as Record<string, unknown>),
    );
    await hello(port);
    for (let index = 0; index < EXTERNAL_TAB_BRIDGE_LIMITS.maxConcurrentRequests; index += 1) {
      port.postMessage({
        type: "openclaw:capability-bridge-request",
        requestId: `timeout-${index}`,
        method: "chat.history",
        params: { sessionKey: "agent:main:linked" },
      });
    }
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledTimes(EXTERNAL_TAB_BRIDGE_LIMITS.maxConcurrentRequests),
    );
    await vi.advanceTimersByTimeAsync(EXTERNAL_TAB_BRIDGE_LIMITS.requestTimeoutMs);

    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "timeout-overflow",
      method: "chat.history",
      params: { sessionKey: "agent:main:linked" },
    });
    await vi.waitFor(() =>
      expect(responses).toContainEqual(
        expect.objectContaining({
          requestId: "timeout-overflow",
          error: expect.objectContaining({ code: "RATE_LIMITED" }),
        }),
      ),
    );
    expect(request).toHaveBeenCalledTimes(EXTERNAL_TAB_BRIDGE_LIMITS.maxConcurrentRequests);
    operations[0]!.resolve({ messages: [] });
    port.postMessage({
      type: "openclaw:capability-bridge-request",
      requestId: "timeout-after-settle",
      method: "chat.history",
      params: { sessionKey: "agent:main:linked" },
    });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledTimes(EXTERNAL_TAB_BRIDGE_LIMITS.maxConcurrentRequests + 1),
    );
    for (const operation of operations) {
      operation.resolve({ messages: [] });
    }
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
