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

// A port is short-lived and rate-limited, so this is a deliberately bounded
// ledger. Once full, a tab reconnects instead of forgetting an operation and
// risking a second mutation with the same logical identifier.
const MAX_MUTATION_OPERATIONS = 1_024;
const MUTATION_RESULT_RETENTION_MS = 60_000;
const SESSION_CREATE_OPERATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type ExternalTabBridgeGatewayClient = {
  request: (method: string, params?: unknown) => Promise<unknown>;
};

type Grant = {
  protocolVersion: 1;
  mode: "read-only" | "read-write";
  methods: string[];
  readMethods: string[];
  /** Authenticated parent binding; deliberately absent from the port envelope. */
  linkedSessionKeys: string[];
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
type MutationOperation = {
  fingerprint: string;
  pending: Promise<unknown> | null;
  outcome:
    | { ok: true; result: unknown; completedAt: number }
    | { ok: false; cause: unknown; completedAt: number }
    | null;
};

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

function isNonEmptyString(value: unknown, maxLength?: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    (maxLength === undefined || value.length <= maxLength)
  );
}

function isOptionalNonEmptyString(value: unknown, maxLength?: number): boolean {
  return value === undefined || isNonEmptyString(value, maxLength);
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
  private readonly mutationOperations = new Map<string, MutationOperation>();

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
      if (isNonEmptyString(key)) this.links.add(key);
    }
  }

  connect(port?: MessagePort): void {
    if (this.revoked) return;
    if (port) {
      this.port = port;
    } else {
      const target = this.options.frame.contentWindow;
      if (!target) return;
      const channel = new MessageChannel();
      this.port = channel.port1;
      target.postMessage(
        {
          type: "openclaw:capability-bridge-connect",
          protocolVersion: 1,
        },
        "*",
        [channel.port2],
      );
    }
    this.port.onmessage = (event) => this.onMessage(event.data);
    this.port.start();
    this.timer = setTimeout(() => this.revoke(), EXTERNAL_TAB_BRIDGE_LIMITS.handshakeTimeoutMs);
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
      // Build the iframe envelope field-by-field. The grant also carries the
      // host-only read classification and linked-session bindings used below.
      this.post({
        type: "openclaw:capability-bridge-ready",
        protocolVersion: 1,
        mode: this.options.grant.mode,
        methods: [...this.options.grant.methods],
        missingRequiredMethods: [...this.options.grant.missingRequiredMethods],
        upgradeRequired: this.options.grant.upgradeRequired,
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
    for (const operation of this.mutationOperations.values()) {
      if (
        operation.outcome &&
        now - operation.outcome.completedAt >= MUTATION_RESULT_RETENTION_MS
      ) {
        operation.outcome = null;
      }
    }
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
    const operationFingerprint = mutation
      ? JSON.stringify({ method: request.method, params: request.params })
      : null;
    const existingOperation = mutation
      ? this.mutationOperations.get(request.operationId as string)
      : undefined;
    if (existingOperation && existingOperation.fingerprint !== operationFingerprint)
      return this.respond(
        requestId,
        undefined,
        error(
          "OPERATION_CONFLICT",
          "Operation id has already been used for a different mutation",
        ),
      );
    if (
      mutation &&
      !existingOperation &&
      this.mutations.length >= EXTERNAL_TAB_BRIDGE_LIMITS.maxMutationsPerMinute
    )
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
      (mutation && !isNonEmptyString(request.operationId, 128)) ||
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
    if (mutation && !existingOperation) this.mutations.push(now);
    this.active += 1;
    try {
      const execution = mutation
        ? this.reconcileMutation(request, operationFingerprint as string)
        : this.dispatch(request);
      this.respond(requestId, await this.timed(execution));
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

  /**
   * Gateway methods do not all expose an idempotency field. Keep one logical
   * mutation per port and retain its authoritative completion for retries;
   * never turn a forgotten bridge timeout into a second write.
   */
  private reconcileMutation(request: Request, fingerprint: string): Promise<unknown> {
    const operationId = request.operationId;
    if (!operationId) {
      throw new Failure("INVALID_PARAMS", "Mutation operation identifier is required");
    }
    const existing = this.mutationOperations.get(operationId);
    if (existing) {
      if (existing.pending) {
        return existing.pending;
      }
      if (existing.outcome?.ok) {
        return Promise.resolve(existing.outcome.result);
      }
      if (existing.outcome && !existing.outcome.ok) {
        return Promise.reject(existing.outcome.cause);
      }
      throw new Failure(
        "MUTATION_RECONCILIATION_REQUIRED",
        "Mutation result has expired; reconcile before retrying",
      );
    }
    if (this.mutationOperations.size >= MAX_MUTATION_OPERATIONS) {
      throw new Failure(
        "MUTATION_RECONCILIATION_REQUIRED",
        "Too many logical mutations on this tab; reconnect before sending another",
      );
    }
    const operation: MutationOperation = { fingerprint, pending: null, outcome: null };
    const pending = this.dispatch(request);
    operation.pending = pending;
    this.mutationOperations.set(operationId, operation);
    void pending.then(
      (result) => {
        operation.pending = null;
        operation.outcome = { ok: true, result, completedAt: this.options.now?.() ?? Date.now() };
      },
      (cause) => {
        operation.pending = null;
        operation.outcome = { ok: false, cause, completedAt: this.options.now?.() ?? Date.now() };
      },
    );
    return pending;
  }

  private async dispatch(request: Request): Promise<unknown> {
    const params = asRecord(request.params);
    if (!params) throw new Failure("INVALID_PARAMS", "Bridge parameters must be an object");
    if (request.method === "sessions.search") return await this.search(params);
    let allowed: Record<string, unknown>;
    if (request.method === "sessions.create") {
      if (
        !this.exact(params, ["agentId", "label", "model", "thinkingLevel"]) ||
        !isNonEmptyString(params.agentId) ||
        !isOptionalNonEmptyString(params.label, 512) ||
        !isOptionalNonEmptyString(params.model) ||
        !isOptionalNonEmptyString(params.thinkingLevel) ||
        !request.operationId ||
        !SESSION_CREATE_OPERATION_ID_RE.test(request.operationId)
      )
        throw new Failure("INVALID_PARAMS", "Invalid session creation parameters");
      // sessions.create already adopts an explicit key atomically. Deriving it
      // from the logical operation keeps retries safe even after this port ends.
      allowed = {
        ...params,
        key: `agent:${params.agentId}:dashboard:bridge-${request.operationId}`,
      };
    } else if (request.method === "chat.history") {
      const limit = params.limit;
      const offset = params.offset;
      if (
        !this.exact(params, ["sessionKey", "limit", "offset"]) ||
        (limit !== undefined &&
          (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100)) ||
        (offset !== undefined && (!Number.isInteger(offset) || (offset as number) < 0))
      )
        throw new Failure("INVALID_PARAMS", "Invalid chat history parameters");
      allowed = { ...params, sessionKey: this.linked(params.sessionKey), maxChars: 500_000 };
    } else if (request.method === "chat.send") {
      if (
        !this.exact(params, ["sessionKey", "message", "thinking", "fastMode"]) ||
        typeof params.message !== "string" ||
        (params.thinking !== undefined && typeof params.thinking !== "string") ||
        (params.fastMode !== undefined &&
          typeof params.fastMode !== "boolean" &&
          params.fastMode !== "auto") ||
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
    return await this.options.client.request(request.method, allowed);
  }

  private async search(params: Record<string, unknown>): Promise<unknown> {
    if (
      !this.exact(params, ["query", "limit"]) ||
      typeof params.query !== "string" ||
      params.query.length > 4_000
    )
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
            await this.options.client.request("sessions.search", {
              query: params.query,
              limit,
              sessionKeys,
              ...(agentId ? { agentId } : {}),
            }),
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
