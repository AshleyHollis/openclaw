/** Private MessagePort bridge for a single opaque sandboxed external tab. */
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
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

// A tab authority is short-lived and rate-limited, so this is a deliberately
// bounded ledger. Once full, it rejects new operation ids instead of forgetting
// one and risking a second mutation with the same logical identifier.
export const EXTERNAL_TAB_BRIDGE_MAX_MUTATION_OPERATIONS = 1_024;
const MUTATION_RESULT_RETENTION_MS = 60_000;
const SESSION_CREATE_OPERATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

type ExternalTabBridgeGatewayClient = {
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
type ExternalTabCapabilityBridgeMutationOperation = {
  fingerprint: string;
  pending: Promise<unknown> | null;
  outcome:
    | { ok: true; result: unknown; completedAt: number }
    | { ok: false; cause: unknown; completedAt: number }
    | null;
};

/**
 * PluginPage owns this bounded state for one authenticated tab authority. It
 * outlives a revoked transport so a reconnect cannot repeat a completed write.
 */
export type ExternalTabCapabilityBridgeMutationState = {
  operations: Map<string, ExternalTabCapabilityBridgeMutationOperation>;
  /**
   * Plugin-owned writes lack a shared idempotency contract. Persist only their
   * operation id and method so a reload can refuse an ambiguous retry without
   * retaining sandbox payloads or Gateway responses.
   */
  tombstones: Map<string, string>;
  persistTombstones?: () => boolean;
};

export function createExternalTabCapabilityBridgeMutationState(params?: {
  tombstones?: Map<string, string>;
  persistTombstones?: () => boolean;
}): ExternalTabCapabilityBridgeMutationState {
  return {
    operations: new Map(),
    tombstones: params?.tombstones ?? new Map(),
    ...(params?.persistTombstones ? { persistTombstones: params.persistTombstones } : {}),
  };
}

class Failure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
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

function searchResultNumber(value: unknown, field: "score" | "timestamp"): number {
  const number = asRecord(value)?.[field];
  return typeof number === "number" && Number.isFinite(number) ? number : 0;
}

/**
 * PluginPage validates the iframe document before handing this controller the
 * private port. From here, the port is the only iframe authority and Gateway
 * identity remains outside every iframe-visible envelope.
 */
export class ExternalTabCapabilityBridgeController {
  private readonly handlePortMessage = (event: MessageEvent) => {
    this.onMessage(event.data);
  };
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
  private readonly mutationOperations: Map<string, ExternalTabCapabilityBridgeMutationOperation>;
  private readonly mutationTombstones: Map<string, string>;

  constructor(
    private readonly options: {
      client: ExternalTabBridgeGatewayClient;
      grant: Grant;
      /**
       * Host-created, authenticated tab authority. It is never taken from the
       * sandbox, so a logical operation id cannot become Gateway-global.
       */
      mutationNamespace: string;
      mutationState?: ExternalTabCapabilityBridgeMutationState;
      linkedSessionKeys?: readonly string[];
      navigate: (sessionKey: string) => void;
      onHandshakeFailure?: () => void;
      now?: () => number;
    },
  ) {
    this.methods = new Set(options.grant.methods);
    this.reads = new Set(options.grant.readMethods);
    this.mutationOperations = options.mutationState?.operations ?? new Map();
    this.mutationTombstones = options.mutationState?.tombstones ?? new Map();
    for (const key of options.linkedSessionKeys ?? []) {
      if (this.links.size === 200) {
        break;
      }
      if (isNonEmptyString(key)) {
        this.links.add(key);
      }
    }
  }

  connect(port: MessagePort): void {
    if (this.revoked) {
      return;
    }
    this.port = port;
    this.port.addEventListener("message", this.handlePortMessage);
    this.port.start();
    this.timer = setTimeout(
      () => this.failHandshake(),
      EXTERNAL_TAB_BRIDGE_LIMITS.handshakeTimeoutMs,
    );
  }

  revoke(): void {
    this.revoked = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = null;
    this.port?.removeEventListener("message", this.handlePortMessage);
    this.port?.close();
    this.port = null;
  }

  private post(value: unknown): void {
    if (!this.port || this.revoked) {
      return;
    }
    if ((byteLength(value) ?? Infinity) > EXTERNAL_TAB_BRIDGE_LIMITS.maxResponseBytes) {
      this.port.postMessage(
        {
          type: "openclaw:capability-bridge-response",
          // SAFETY: only the optional request id is read before the full request is validated.
          requestId: (value as { requestId?: string }).requestId ?? "", // SAFETY: only an optional id is read pre-validation.
          error: error("RESULT_TOO_LARGE", "Bridge response exceeds the public limit"),
        },
        [],
      );
      return;
    }
    this.port.postMessage(value, []);
  }

  private onMessage(value: unknown): void {
    if (this.revoked || !this.port) {
      return;
    }
    const message = asRecord(value);
    if (message?.type === "openclaw:capability-bridge-revoke") {
      return this.revoke();
    }
    if (message?.type === "openclaw:capability-bridge-hello") {
      if (this.hello) {
        return this.revoke();
      }
      if (message.protocolVersion !== 1) {
        return this.failHandshake();
      }
      this.hello = true;
      if (this.timer) {
        clearTimeout(this.timer);
      }
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
    if (!this.hello) {
      return this.failHandshake();
    }
    void this.handle(value);
  }

  private failHandshake(): void {
    if (this.revoked || this.hello) {
      return;
    }
    this.revoke();
    this.options.onHandshakeFailure?.();
  }

  private trim(now: number): void {
    this.requests = this.requests.filter((at) => now - at < 60_000);
    this.mutations = this.mutations.filter((at) => now - at < 60_000);
    for (const [id, at] of this.requestIds) {
      if (now - at >= 60_000) {
        this.requestIds.delete(id);
      }
    }
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
    // SAFETY: every Request field is validated by the closed-envelope checks immediately below.
    const request = asRecord(value) as Request | null; // SAFETY: the closed Request envelope is validated below.
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
    ) {
      return this.respond(
        requestId,
        undefined,
        error("INVALID_PARAMS", "Malformed capability bridge request"),
      );
    }
    const now = this.options.now?.() ?? Date.now();
    this.trim(now);
    if (this.requestIds.has(requestId)) {
      return this.respond(
        requestId,
        undefined,
        error("INVALID_PARAMS", "Request id has already been used"),
      );
    }
    const mutation = !this.reads.has(request.method);
    const operationFingerprint = mutation
      ? JSON.stringify({ method: request.method, params: request.params })
      : null;
    const existingOperation = mutation
      ? // SAFETY: mutation is true only after operationId passes the non-empty string guard below.
        this.mutationOperations.get(request.operationId as string) // SAFETY: mutation admission requires a string id.
      : undefined;
    if (existingOperation && existingOperation.fingerprint !== operationFingerprint) {
      return this.respond(
        requestId,
        undefined,
        error("OPERATION_CONFLICT", "Operation id has already been used for a different mutation"),
      );
    }
    const tombstoneMethod =
      mutation && !existingOperation
        ? // SAFETY: mutation requests require a non-empty operationId before reconciliation.
          this.mutationTombstones.get(request.operationId as string) // SAFETY: mutation admission requires a string id.
        : undefined;
    if (tombstoneMethod && tombstoneMethod !== request.method) {
      return this.respond(
        requestId,
        undefined,
        error("OPERATION_CONFLICT", "Operation id has already been used for a different mutation"),
      );
    }
    if (tombstoneMethod) {
      return this.respond(
        requestId,
        undefined,
        error(
          "MUTATION_RECONCILIATION_REQUIRED",
          "Mutation outcome is unknown; reconcile before retrying",
        ),
      );
    }
    // The 200-key link cap and ingress rate cap bound total host work.
    // Search groups dispatch serially, so they occupy one downstream slot.
    // Counting groups there would reject valid exact-set searches before Gateway sees them.
    const rateUnits = 1;
    const downstreamConcurrencyUnits = 1;
    if (this.requests.length + rateUnits > EXTERNAL_TAB_BRIDGE_LIMITS.maxRequestsPerMinute) {
      return this.respond(
        requestId,
        undefined,
        error("RATE_LIMITED", "Bridge request rate limit exceeded", true, 60_000),
      );
    }
    if (
      this.active + downstreamConcurrencyUnits >
      EXTERNAL_TAB_BRIDGE_LIMITS.maxConcurrentRequests
    ) {
      return this.respond(
        requestId,
        undefined,
        error("RATE_LIMITED", "Bridge request concurrency limit exceeded", true, 60_000),
      );
    }
    this.requestIds.set(requestId, now);
    this.requests.push(now);
    if (
      mutation &&
      !existingOperation &&
      this.mutations.length >= EXTERNAL_TAB_BRIDGE_LIMITS.maxMutationsPerMinute
    ) {
      return this.respond(
        requestId,
        undefined,
        error("RATE_LIMITED", "Bridge mutation rate limit exceeded", true, 60_000),
      );
    }
    if (!this.methods.has(request.method)) {
      return this.respond(
        requestId,
        undefined,
        error("METHOD_NOT_GRANTED", "Method is not granted to this tab"),
      );
    }
    if (
      (mutation && !isNonEmptyString(request.operationId, 128)) ||
      (!mutation && request.operationId !== undefined)
    ) {
      return this.respond(
        requestId,
        undefined,
        error(
          "INVALID_PARAMS",
          "Mutation operation identifiers are required and read identifiers are forbidden",
        ),
      );
    }
    if (
      mutation &&
      !existingOperation &&
      this.requiresDurableReconciliation(request.method) &&
      // SAFETY: this branch is reachable only for a validated mutation operation id.
      !this.reserveMutationTombstone(request.operationId as string, request.method) // SAFETY: mutation admission requires a string id.
    ) {
      return this.respond(
        requestId,
        undefined,
        error(
          "MUTATION_RECONCILIATION_REQUIRED",
          "Mutation requires durable reconciliation before it can be sent",
        ),
      );
    }
    if (mutation && !existingOperation) {
      this.mutations.push(now);
    }
    this.active += downstreamConcurrencyUnits;
    let executionStarted = false;
    let released = false;
    const releaseDownstreamSlot = () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= downstreamConcurrencyUnits;
    };
    try {
      const execution = mutation
        ? // SAFETY: mutation fingerprinting above always returns a string for valid mutations.
          this.reconcileMutation(request, operationFingerprint as string) // SAFETY: valid mutations always produce a fingerprint.
        : this.dispatch(request);
      executionStarted = true;
      // A timeout stops waiting for the sandbox response, not Gateway work.
      // Keep this slot reserved until the original operation settles so retries
      // cannot exceed the port's real downstream concurrency bound.
      void execution.then(releaseDownstreamSlot, releaseDownstreamSlot);
      this.respond(requestId, await this.timed(execution));
    } catch (cause) {
      if (!executionStarted) {
        releaseDownstreamSlot();
      }
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
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private exact(params: Record<string, unknown>, names: string[]): boolean {
    return Object.keys(params).every((key) => names.includes(key));
  }
  private linked(value: unknown): string {
    if (typeof value !== "string" || !this.links.has(value)) {
      throw new Failure("SESSION_NOT_LINKED", "Session is not linked to this tab");
    }
    return value;
  }

  private requiresDurableReconciliation(method: string): boolean {
    return method !== "sessions.create" && method !== "chat.send";
  }

  private reserveMutationTombstone(operationId: string, method: string): boolean {
    if (this.mutationTombstones.size >= EXTERNAL_TAB_BRIDGE_MAX_MUTATION_OPERATIONS) {
      return false;
    }
    this.mutationTombstones.set(operationId, method);
    try {
      if (this.options.mutationState?.persistTombstones?.() === false) {
        this.mutationTombstones.delete(operationId);
        return false;
      }
    } catch {
      this.mutationTombstones.delete(operationId);
      return false;
    }
    return true;
  }

  /**
   * Gateway methods do not all expose an idempotency field. Keep one logical
   * mutation per authenticated tab authority and retain its completion across
   * transport remounts; never turn a forgotten timeout into a second write.
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
        const cause = existing.outcome.cause;
        return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
      throw new Failure(
        "MUTATION_RECONCILIATION_REQUIRED",
        "Mutation result has expired; reconcile before retrying",
      );
    }
    if (this.mutationOperations.size >= EXTERNAL_TAB_BRIDGE_MAX_MUTATION_OPERATIONS) {
      throw new Failure(
        "MUTATION_RECONCILIATION_REQUIRED",
        "Too many logical mutations on this tab authority; reconcile before sending another",
      );
    }
    const operation: ExternalTabCapabilityBridgeMutationOperation = {
      fingerprint,
      pending: null,
      outcome: null,
    };
    const pending = this.dispatch(request);
    operation.pending = pending;
    this.mutationOperations.set(operationId, operation);
    void pending.then(
      (result) => {
        operation.pending = null;
        operation.outcome = { ok: true, result, completedAt: this.options.now?.() ?? Date.now() };
      },
      (cause: unknown) => {
        operation.pending = null;
        operation.outcome = { ok: false, cause, completedAt: this.options.now?.() ?? Date.now() };
      },
    );
    return pending;
  }

  private async dispatch(request: Request): Promise<unknown> {
    const params = asRecord(request.params);
    if (!params) {
      throw new Failure("INVALID_PARAMS", "Bridge parameters must be an object");
    }
    if (request.method === "sessions.search") {
      return await this.search(params);
    }
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
      ) {
        throw new Failure("INVALID_PARAMS", "Invalid session creation parameters");
      }
      // sessions.create already adopts an explicit key atomically. Deriving it
      // from host tab authority plus the logical operation keeps retries safe
      // without allowing two authenticated tabs to adopt each other's key.
      allowed = {
        ...params,
        key: `agent:${params.agentId}:dashboard:bridge-${this.options.mutationNamespace}-${request.operationId}`,
      };
    } else if (request.method === "chat.history") {
      const limit = params.limit;
      const offset = params.offset;
      if (
        !this.exact(params, ["sessionKey", "limit", "offset"]) ||
        (limit !== undefined &&
          (!Number.isInteger(limit) ||
            // SAFETY: Number.isInteger proves the unknown value is numeric before range checks.
            (limit as number) < 1 || // SAFETY: Number.isInteger established a number.
            // SAFETY: Number.isInteger proves the unknown value is numeric before range checks.
            (limit as number) > 100)) || // SAFETY: Number.isInteger established a number.
        (offset !== undefined &&
          (!Number.isInteger(offset) ||
            // SAFETY: Number.isInteger proves the unknown value is numeric before the range check.
            (offset as number) < 0)) // SAFETY: Number.isInteger established a number.
      ) {
        throw new Failure("INVALID_PARAMS", "Invalid chat history parameters");
      }
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
      ) {
        throw new Failure("INVALID_PARAMS", "Invalid chat send parameters");
      }
      allowed = {
        ...params,
        sessionKey: this.linked(params.sessionKey),
        idempotencyKey: `bridge:${this.options.mutationNamespace}:${request.operationId}`,
      };
    } else if (request.method === "ui.session.navigate") {
      if (!this.exact(params, ["sessionKey"])) {
        throw new Failure("INVALID_PARAMS", "Invalid session navigation parameters");
      }
      this.options.navigate(this.linked(params.sessionKey));
      return undefined;
    } else {
      allowed = params;
    }
    return await this.options.client.request(request.method, allowed);
  }

  private async search(params: Record<string, unknown>): Promise<unknown> {
    const plan = this.searchPlan(params);
    if (plan.groups.length === 0) {
      return { results: [] };
    }
    const candidates: unknown[] = [];
    let indexing = false;
    let truncated = false;
    let responseBytes = 0;
    for (const group of plan.groups) {
      const response = asRecord(
        await this.options.client.request("sessions.search", {
          query: plan.query,
          limit: plan.limit,
          sessionKeys: group.sessionKeys,
          ...(group.agentId ? { agentId: group.agentId } : {}),
        }),
      ) ?? { results: [] };
      const nextResponseBytes = byteLength(response);
      if (
        nextResponseBytes === null ||
        nextResponseBytes > EXTERNAL_TAB_BRIDGE_LIMITS.maxResponseBytes - responseBytes
      ) {
        throw new Failure("RESULT_TOO_LARGE", "Bridge search response exceeds the public limit");
      }
      responseBytes += nextResponseBytes;
      indexing ||= response.indexing === true;
      truncated ||= response.truncated === true;
      if (Array.isArray(response.results)) {
        candidates.push(...response.results);
      }
    }
    const results = candidates
      .toSorted(
        (left, right) =>
          searchResultNumber(right, "score") - searchResultNumber(left, "score") ||
          searchResultNumber(right, "timestamp") - searchResultNumber(left, "timestamp"),
      )
      .slice(0, plan.limit);
    return {
      results,
      ...(indexing ? { indexing: true } : {}),
      ...(truncated || candidates.length > results.length ? { truncated: true } : {}),
    };
  }

  private searchPlan(params: Record<string, unknown>): {
    query: string;
    limit: number;
    groups: Array<{ agentId: string; sessionKeys: string[] }>;
  } {
    if (
      !this.exact(params, ["query", "limit"]) ||
      typeof params.query !== "string" ||
      params.query.length > 4_000
    ) {
      throw new Failure("INVALID_PARAMS", "Invalid session search parameters");
    }
    const limit = params.limit === undefined ? 25 : params.limit;
    if (
      !Number.isInteger(limit) ||
      // SAFETY: Number.isInteger proves the unknown value is numeric before range checks.
      (limit as number) < 1 || // SAFETY: Number.isInteger established a number.
      // SAFETY: Number.isInteger proves the unknown value is numeric before range checks.
      (limit as number) > 25 // SAFETY: Number.isInteger established a number.
    ) {
      throw new Failure("INVALID_PARAMS", "Invalid session search limit");
    }
    const byAgent = new Map<string, string[]>();
    for (const key of this.links) {
      const agent = parseAgentSessionKey(key)?.agentId ?? "";
      byAgent.set(agent, [...(byAgent.get(agent) ?? []), key]);
    }
    return {
      query: params.query,
      // SAFETY: the integer and bounded-range checks above establish a numeric limit.
      limit: limit as number, // SAFETY: the bounded integer checks above establish the type.
      groups: [...byAgent.entries()].map(([agentId, sessionKeys]) => ({ agentId, sessionKeys })),
    };
  }
}
