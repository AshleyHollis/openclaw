/** Private MessagePort bridge for a single opaque sandboxed external tab. */
import { parseAgentSessionKey } from "./sessions/session-key.ts";

export const EXTERNAL_TAB_BRIDGE_LIMITS = {
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 1024 * 1024,
  maxConcurrentRequests: 8,
  maxRequestsPerMinute: 60,
  maxMutationsPerMinute: 12,
  handshakeTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
} as const;

export type ExternalTabBridgeGatewayClient = {
  request: (method: string, params?: unknown) => Promise<unknown>;
};

type Grant = {
  protocolVersion: 1;
  mode: "read-only" | "read-write";
  methods: string[];
  readMethods: string[];
  missingRequiredMethods: string[];
  upgradeRequired: boolean;
};
type Request = {
  type: string;
  requestId: string;
  method: string;
  params: unknown;
  operationId?: string;
};
type PublicError = { code: string; message: string; retryable: boolean; retryAfterMs?: number };

class Failure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function byteLength(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? new TextEncoder().encode(json).byteLength : null;
  } catch {
    return null;
  }
}

function error(
  code: string,
  message: string,
  retryable = false,
  retryAfterMs?: number,
): PublicError {
  return { code, message, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

/**
 * The port is the only iframe authority. Frame identity and Gateway identity
 * are intentionally retained in this controller and never posted to the port.
 */
export class ExternalTabCapabilityBridgeController {
  private port: MessagePort | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private hello = false;
  private revoked = false;
  private active = 0;
  private requests: number[] = [];
  private mutations: number[] = [];
  private readonly requestIds = new Map<string, number>();
  private readonly links = new Set<string>();
  private readonly methods: Set<string>;
  private readonly reads: Set<string>;

  constructor(
    private readonly options: {
      frame: HTMLIFrameElement;
      client: ExternalTabBridgeGatewayClient;
      grant: Grant;
      linkedSessionKeys?: readonly string[];
      navigate: (sessionKey: string) => void;
      now?: () => number;
    },
  ) {
    this.methods = new Set(options.grant.methods);
    this.reads = new Set(options.grant.readMethods);
    for (const key of options.linkedSessionKeys ?? []) {
      if (this.links.size === 200) break;
      this.links.add(key);
    }
  }

  connect(): void {
    const target = this.options.frame.contentWindow;
    if (!target || this.revoked) return;
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (event) => this.onMessage(event.data);
    this.timer = setTimeout(() => this.revoke(), EXTERNAL_TAB_BRIDGE_LIMITS.handshakeTimeoutMs);
    target.postMessage({ type: "openclaw:capability-bridge-connect", protocolVersion: 1 }, "*", [
      channel.port2,
    ]);
  }

  revoke(): void {
    this.revoked = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.port?.close();
    this.port = null;
  }

  private post(value: unknown): void {
    if (!this.port || this.revoked) return;
    if ((byteLength(value) ?? Infinity) > EXTERNAL_TAB_BRIDGE_LIMITS.maxResponseBytes) {
      this.port.postMessage({
        type: "openclaw:capability-bridge-response",
        requestId: (value as { requestId?: string }).requestId ?? "",
        error: error("RESULT_TOO_LARGE", "Bridge response exceeds the public limit"),
      });
      return;
    }
    this.port.postMessage(value);
  }

  private onMessage(value: unknown): void {
    if (this.revoked || !this.port) return;
    const message = asRecord(value);
    if (message?.type === "openclaw:capability-bridge-revoke") return this.revoke();
    if (message?.type === "openclaw:capability-bridge-hello") {
      if (this.hello || message.protocolVersion !== 1) return this.revoke();
      this.hello = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      const { readMethods: _readMethods, ...ready } = this.options.grant;
      this.post({
        type: "openclaw:capability-bridge-ready",
        ...ready,
        limits: EXTERNAL_TAB_BRIDGE_LIMITS,
      });
      return;
    }
    if (!this.hello) return this.revoke();
    void this.handle(value);
  }

  private trim(now: number): void {
    this.requests = this.requests.filter((at) => now - at < 60_000);
    this.mutations = this.mutations.filter((at) => now - at < 60_000);
    for (const [id, at] of this.requestIds) if (now - at >= 60_000) this.requestIds.delete(id);
  }

  private respond(requestId: string, result?: unknown, failure?: PublicError): void {
    this.post({
      type: "openclaw:capability-bridge-response",
      requestId,
      ...(failure ? { error: failure } : { result }),
    });
  }

  private async handle(value: unknown): Promise<void> {
    const request = asRecord(value) as Request | null;
    const requestId = typeof request?.requestId === "string" ? request.requestId : "";
    if (
      !request ||
      (byteLength(value) ?? Infinity) > EXTERNAL_TAB_BRIDGE_LIMITS.maxRequestBytes ||
      request.type !== "openclaw:capability-bridge-request" ||
      !requestId ||
      requestId.length > 128 ||
      typeof request.method !== "string" ||
      !Object.hasOwn(request, "params") ||
      !Object.keys(request).every((key) =>
        ["type", "requestId", "method", "params", "operationId"].includes(key),
      )
    )
      return this.respond(
        requestId,
        undefined,
        error("INVALID_PARAMS", "Malformed capability bridge request"),
      );
    const now = this.options.now?.() ?? Date.now();
    this.trim(now);
    if (this.requestIds.has(requestId))
      return this.respond(
        requestId,
        undefined,
        error("INVALID_PARAMS", "Request id has already been used"),
      );
    if (this.requests.length >= EXTERNAL_TAB_BRIDGE_LIMITS.maxRequestsPerMinute)
      return this.respond(
        requestId,
        undefined,
        error("RATE_LIMITED", "Bridge request rate limit exceeded", true, 60_000),
      );
    this.requestIds.set(requestId, now);
    this.requests.push(now);
    if (this.active >= EXTERNAL_TAB_BRIDGE_LIMITS.maxConcurrentRequests)
      return this.respond(
        requestId,
        undefined,
        error("RATE_LIMITED", "Bridge request concurrency limit exceeded", true, 60_000),
      );
    const mutation = !this.reads.has(request.method);
    if (mutation && this.mutations.length >= EXTERNAL_TAB_BRIDGE_LIMITS.maxMutationsPerMinute)
      return this.respond(
        requestId,
        undefined,
        error("RATE_LIMITED", "Bridge mutation rate limit exceeded", true, 60_000),
      );
    if (!this.methods.has(request.method))
      return this.respond(
        requestId,
        undefined,
        error("METHOD_NOT_GRANTED", "Method is not granted to this tab"),
      );
    if (
      (mutation && (!request.operationId || typeof request.operationId !== "string")) ||
      (!mutation && request.operationId !== undefined)
    )
      return this.respond(
        requestId,
        undefined,
        error(
          "INVALID_PARAMS",
          "Mutation operation identifiers are required and read identifiers are forbidden",
        ),
      );
    if (mutation) this.mutations.push(now);
    this.active += 1;
    try {
      this.respond(requestId, await this.dispatch(request));
    } catch (cause) {
      const timeout = cause instanceof Failure && cause.code === "TIMEOUT";
      const retryable = timeout && (!mutation || request.method === "chat.send");
      const unknown = timeout && mutation && !retryable;
      this.respond(
        requestId,
        undefined,
        error(
          unknown
            ? "MUTATION_OUTCOME_UNKNOWN"
            : cause instanceof Failure
              ? cause.code
              : "INVALID_PARAMS",
          unknown
            ? "Mutation outcome is unknown; reconcile before retrying"
            : timeout && request.method === "chat.send"
              ? "Chat send timed out; retry with a new request id and the same operation id"
              : cause instanceof Failure
                ? cause.message
                : "Gateway rejected bridge request",
          retryable,
        ),
      );
    } finally {
      this.active -= 1;
    }
  }

  private async timed<T>(value: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        value,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Failure("TIMEOUT", "Bridge request timed out")),
            EXTERNAL_TAB_BRIDGE_LIMITS.requestTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private exact(params: Record<string, unknown>, names: string[]): boolean {
    return Object.keys(params).every((key) => names.includes(key));
  }
  private linked(value: unknown): string {
    if (typeof value !== "string" || !this.links.has(value))
      throw new Failure("SESSION_NOT_LINKED", "Session is not linked to this tab");
    return value;
  }
  private async dispatch(request: Request): Promise<unknown> {
    const params = asRecord(request.params);
    if (!params) throw new Failure("INVALID_PARAMS", "Bridge parameters must be an object");
    if (request.method === "sessions.search") return await this.search(params);
    let allowed: Record<string, unknown>;
    if (request.method === "sessions.create") {
      if (!this.exact(params, ["agentId", "label", "model", "thinkingLevel"]))
        throw new Failure("INVALID_PARAMS", "Invalid session creation parameters");
      allowed = params;
    } else if (request.method === "chat.history") {
      const limit = params.limit;
      if (
        !this.exact(params, ["sessionKey", "limit", "offset"]) ||
        (limit !== undefined &&
          (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100))
      )
        throw new Failure("INVALID_PARAMS", "Invalid chat history parameters");
      allowed = { ...params, sessionKey: this.linked(params.sessionKey), maxChars: 500_000 };
    } else if (request.method === "chat.send") {
      if (
        !this.exact(params, ["sessionKey", "message", "thinking", "fastMode"]) ||
        typeof params.message !== "string" ||
        !request.operationId
      )
        throw new Failure("INVALID_PARAMS", "Invalid chat send parameters");
      allowed = {
        ...params,
        sessionKey: this.linked(params.sessionKey),
        idempotencyKey: request.operationId,
      };
    } else if (request.method === "ui.session.navigate") {
      if (!this.exact(params, ["sessionKey"]))
        throw new Failure("INVALID_PARAMS", "Invalid session navigation parameters");
      this.options.navigate(this.linked(params.sessionKey));
      return undefined;
    } else allowed = params;
    const result = await this.timed(this.options.client.request(request.method, allowed));
    if (request.method === "sessions.create") {
      const created = asRecord(result);
      const key =
        typeof created?.key === "string"
          ? created.key
          : typeof created?.sessionKey === "string"
            ? created.sessionKey
            : undefined;
      if (key && this.links.size < 200) this.links.add(key);
    }
    return result;
  }

  private async search(params: Record<string, unknown>): Promise<unknown> {
    if (!this.exact(params, ["query", "limit"]) || typeof params.query !== "string")
      throw new Failure("INVALID_PARAMS", "Invalid session search parameters");
    const limit = params.limit === undefined ? 25 : params.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 25)
      throw new Failure("INVALID_PARAMS", "Invalid session search limit");
    if (this.links.size === 0) return { results: [] };
    const byAgent = new Map<string, string[]>();
    for (const key of this.links) {
      const agent = parseAgentSessionKey(key)?.agentId ?? "";
      byAgent.set(agent, [...(byAgent.get(agent) ?? []), key]);
    }
    const responses = await Promise.all(
      [...byAgent.entries()].map(
        async ([agentId, sessionKeys]) =>
          asRecord(
            await this.timed(
              this.options.client.request("sessions.search", {
                query: params.query,
                limit,
                sessionKeys,
                ...(agentId ? { agentId } : {}),
              }),
            ),
          ) ?? { results: [] },
      ),
    );
    const results = responses
      .flatMap((response) => (Array.isArray(response.results) ? response.results : []))
      .slice(0, limit as number);
    return {
      results,
      ...(responses.some((response) => response.indexing === true) ? { indexing: true } : {}),
    };
  }
}
