// Host-owned, closed notification candidate contract. No credential-bearing type is exported.
import { createHash } from "node:crypto";
import { isOperatorScope, type OperatorScope } from "../gateway/operator-scopes.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const DAY = 86_400_000;
export type PluginNotificationDeclarationV1 = {
  version: 1;
  id: string;
  requiredScopes: OperatorScope[];
  destinations: Array<{ id: string; tabId: string }>;
};
export type PluginNotificationCandidateV1 = {
  version: 1;
  emissionId: string;
  logicalOperationId: string;
  attentionClass: "active" | "time-sensitive";
  preview: { title: string; body: string };
  deepLink: { kind: "plugin-detail"; destinationId: string; recordId: string };
  expiresAtMs: number;
};
export type PluginNotificationClearV1 = { version: 1; logicalOperationId: string };
export type PluginNotificationEmitResult = {
  status:
    | "sent"
    | "partial"
    | "suppressed"
    | "expired"
    | "rate-limited"
    | "no-targets"
    | "failed"
    | "ambiguous";
  attempted: number;
  delivered: number;
  failed: number;
  ambiguous: number;
  retryAfterMs?: number;
};
export type PluginNotificationClearResult = {
  status: "cleared" | "already-cleared" | "partial" | "ambiguous";
  attempted: number;
  cleared: number;
  failed: number;
  ambiguous: number;
};
export type PluginNotificationEmitter = {
  bindCurrentOperator(): PluginNotificationBinding | undefined;
};
export type PluginNotificationBinding = {
  emit(candidate: PluginNotificationCandidateV1): Promise<PluginNotificationEmitResult>;
  clear(request: PluginNotificationClearV1): Promise<PluginNotificationClearResult>;
};
export type PluginNotificationTarget = { readonly id: string };
/** Host-captured identity. This never crosses the plugin SDK boundary. */
export type PluginNotificationPrincipal = {
  readonly operatorId: string;
  readonly pluginId: string;
  readonly authenticationMethod: "device-token";
  readonly authenticationGeneration: string;
  readonly pairedDeviceId: string;
  readonly pairingGeneration: string;
  readonly issuerGeneration?: string;
  readonly scopes: readonly OperatorScope[];
};
export type PluginNotificationTransportPayload = {
  version: 1;
  kind: "notify" | "clear";
  tag: string;
  expiresAtMs: number;
  /** Remaining delivery lifetime, bounded by the host immediately before I/O. */
  ttlMs: number;
  attentionClass?: "active" | "time-sensitive";
  preview?: { title: string; body: string };
  target?: {
    kind: "plugin-detail";
    pluginId: string;
    tabId: string;
    destinationId: string;
    recordId: string;
  };
};
export type PluginNotificationTransport = {
  send(
    target: PluginNotificationTarget,
    payload: PluginNotificationTransportPayload,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<"accepted" | "failed" | "ambiguous" | "suppressed">;
  clear(
    target: PluginNotificationTarget,
    payload: PluginNotificationTransportPayload,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<"accepted" | "failed" | "ambiguous">;
};

export type PluginNotificationAttemptOutcome = "accepted" | "failed" | "ambiguous" | "suppressed";
export type PluginNotificationLedger = {
  claimEmission(params: {
    principal: PluginNotificationPrincipal;
    declarationId: string;
    emissionId: string;
    logicalOperationId: string;
    candidateHash: string;
    expiresAtMs: number;
    targetIds: readonly string[];
    nowMs: number;
  }):
    | { kind: "claimed"; targetIds: readonly string[] }
    | { kind: "replay"; result: PluginNotificationEmitResult }
    | { kind: "conflict" }
    | { kind: "rate-limited"; retryAfterMs: number }
    | { kind: "in-flight" }
    | { kind: "cleared" };
  completeEmission(params: {
    principal: PluginNotificationPrincipal;
    emissionId: string;
    result: PluginNotificationEmitResult;
    outcomes: ReadonlyMap<string, PluginNotificationAttemptOutcome>;
    nowMs: number;
  }): readonly string[];
  claimClear(params: {
    principal: PluginNotificationPrincipal;
    logicalOperationId: string;
    nowMs: number;
  }):
    | { kind: "claimed"; targetIds: readonly string[]; clearedTargetIds: readonly string[] }
    | { kind: "replay"; result: PluginNotificationClearResult }
    | { kind: "in-flight" };
  completeClear(params: {
    principal: PluginNotificationPrincipal;
    logicalOperationId: string;
    result: PluginNotificationClearResult;
    outcomes: ReadonlyMap<string, Exclude<PluginNotificationAttemptOutcome, "suppressed">>;
    nowMs: number;
  }): void;
};

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length &&
  Object.keys(value).every((key) => expected.includes(key));
const scalar = (value: string) => {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
};
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  scalar(value) &&
  [...value].length > 0 &&
  [...value].length <= max &&
  !CONTROL.test(value);
const failure = (): PluginNotificationEmitResult => ({
  status: "failed",
  attempted: 0,
  delivered: 0,
  failed: 1,
  ambiguous: 0,
});

export function validatePluginNotificationDeclaration(
  value: unknown,
  params: {
    pluginId: string;
    existingCount: number;
    resolveTab?: (pluginId: string, tabId: string) => boolean;
  },
): value is PluginNotificationDeclarationV1 {
  if (
    !plain(value) ||
    !keys(value, ["version", "id", "requiredScopes", "destinations"]) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    params.existingCount >= 8 ||
    !Array.isArray(value.requiredScopes) ||
    value.requiredScopes.length === 0 ||
    !value.requiredScopes.every(isOperatorScope) ||
    !Array.isArray(value.destinations) ||
    value.destinations.length === 0 ||
    value.destinations.length > 8
  )
    return false;
  const destinationIds = new Set<string>();
  return value.destinations.every(
    (destination) =>
      plain(destination) &&
      keys(destination, ["id", "tabId"]) &&
      typeof destination.id === "string" &&
      typeof destination.tabId === "string" &&
      ID.test(destination.id) &&
      ID.test(destination.tabId) &&
      !destinationIds.has(destination.id) &&
      (destinationIds.add(destination.id),
      params.resolveTab === undefined || params.resolveTab(params.pluginId, destination.tabId)),
  );
}

function canonical(candidate: PluginNotificationCandidateV1): string {
  return JSON.stringify({
    version: 1,
    emissionId: candidate.emissionId,
    logicalOperationId: candidate.logicalOperationId,
    attentionClass: candidate.attentionClass,
    preview: { title: candidate.preview.title, body: candidate.preview.body },
    deepLink: {
      kind: "plugin-detail",
      destinationId: candidate.deepLink.destinationId,
      recordId: candidate.deepLink.recordId,
    },
    expiresAtMs: candidate.expiresAtMs,
  });
}
export function validatePluginNotificationCandidate(
  value: unknown,
  declaration: PluginNotificationDeclarationV1,
  nowMs = Date.now(),
): value is PluginNotificationCandidateV1 {
  if (
    !plain(value) ||
    !keys(value, [
      "version",
      "emissionId",
      "logicalOperationId",
      "attentionClass",
      "preview",
      "deepLink",
      "expiresAtMs",
    ]) ||
    value.version !== 1 ||
    typeof value.emissionId !== "string" ||
    !ID.test(value.emissionId) ||
    typeof value.logicalOperationId !== "string" ||
    !ID.test(value.logicalOperationId) ||
    (value.attentionClass !== "active" && value.attentionClass !== "time-sensitive") ||
    !plain(value.preview) ||
    !keys(value.preview, ["title", "body"]) ||
    !text(value.preview.title, 80) ||
    !text(value.preview.body, 256) ||
    !plain(value.deepLink) ||
    !keys(value.deepLink, ["kind", "destinationId", "recordId"]) ||
    value.deepLink.kind !== "plugin-detail" ||
    typeof value.deepLink.destinationId !== "string" ||
    typeof value.deepLink.recordId !== "string" ||
    !ID.test(value.deepLink.destinationId) ||
    !ID.test(value.deepLink.recordId) ||
    !declaration.destinations.some(
      (destination) => destination.id === value.deepLink.destinationId,
    ) ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs <= nowMs ||
    value.expiresAtMs > nowMs + DAY
  )
    return false;
  return Buffer.byteLength(canonical(value as PluginNotificationCandidateV1), "utf8") <= 2048;
}
export const pluginNotificationOperationTopic = (
  principal: Pick<PluginNotificationPrincipal, "operatorId" | "pluginId">,
  logicalOperationId: string,
) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        operatorId: principal.operatorId,
        pluginId: principal.pluginId,
        logicalOperationId,
      }),
    )
    .digest("base64url")
    .slice(0, 32);
const validClear = (value: unknown): value is PluginNotificationClearV1 =>
  plain(value) &&
  keys(value, ["version", "logicalOperationId"]) &&
  value.version === 1 &&
  typeof value.logicalOperationId === "string" &&
  ID.test(value.logicalOperationId);

const maximumTransportAttemptMs = 10_000;

function principalForLegacyOperator(
  pluginId: string,
  operatorId: string,
): PluginNotificationPrincipal {
  return {
    operatorId,
    pluginId,
    authenticationMethod: "device-token",
    authenticationGeneration: `legacy:${operatorId}`,
    pairedDeviceId: `legacy:${operatorId}`,
    pairingGeneration: `legacy:${operatorId}`,
    scopes: [],
  };
}

function deadlineOptions(
  expiresAtMs: number,
  nowMs: number,
): {
  signal: AbortSignal;
  timeoutMs: number;
  cancel: () => void;
} | null {
  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs <= 0) return null;
  const timeoutMs = Math.min(remainingMs, maximumTransportAttemptMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, timeoutMs, cancel: () => clearTimeout(timer) };
}

async function sendWithinDeadline(
  expiresAtMs: number,
  now: () => number,
  run: (options: {
    signal: AbortSignal;
    timeoutMs: number;
  }) => Promise<PluginNotificationAttemptOutcome>,
): Promise<PluginNotificationAttemptOutcome> {
  const deadline = deadlineOptions(expiresAtMs, now());
  if (!deadline) return "suppressed";
  try {
    const result = await Promise.race([
      run({ signal: deadline.signal, timeoutMs: deadline.timeoutMs }),
      new Promise<"ambiguous">((resolve) => {
        deadline.signal.addEventListener("abort", () => resolve("ambiguous"), { once: true });
      }),
    ]);
    // A response arriving after the deadline cannot prove the remote endpoint did not accept it.
    return deadline.signal.aborted ? "ambiguous" : result;
  } catch {
    return "ambiguous";
  } finally {
    deadline.cancel();
  }
}

/** Coordinates a logical emission. Durable host ledgers claim before transport I/O. */
export class PluginNotificationCoordinator {
  private emissions = new Map<string, { hash: string; result: PluginNotificationEmitResult }>();
  private rates = new Map<string, number[]>();
  private targets = new Map<string, Map<string, PluginNotificationTarget>>();
  private cleared = new Set<string>();
  constructor(
    private readonly options: {
      pluginId: string;
      declaration: PluginNotificationDeclarationV1;
      targets(operator: string | PluginNotificationPrincipal): readonly PluginNotificationTarget[];
      transport: PluginNotificationTransport;
      now?: () => number;
      ledger?: PluginNotificationLedger;
    },
  ) {}
  async emit(
    operator: string | PluginNotificationPrincipal,
    candidate: unknown,
  ): Promise<PluginNotificationEmitResult> {
    const now = this.options.now?.() ?? Date.now();
    if (!validatePluginNotificationCandidate(candidate, this.options.declaration, now))
      return failure();
    const c = candidate;
    const principal =
      typeof operator === "string"
        ? principalForLegacyOperator(this.options.pluginId, operator)
        : operator;
    if (principal.pluginId !== this.options.pluginId) return failure();
    const operatorKey = principal.operatorId;
    const key = JSON.stringify([operatorKey, this.options.pluginId, c.emissionId]);
    const hash = createHash("sha256").update(canonical(c)).digest("hex");
    const targets = this.options.targets(principal);
    const claimed = this.options.ledger?.claimEmission({
      principal,
      declarationId: this.options.declaration.id,
      emissionId: c.emissionId,
      logicalOperationId: c.logicalOperationId,
      candidateHash: hash,
      expiresAtMs: c.expiresAtMs,
      targetIds: targets.map((target) => target.id),
      nowMs: now,
    });
    if (claimed?.kind === "replay") return claimed.result;
    if (claimed?.kind === "conflict") return failure();
    if (claimed?.kind === "in-flight")
      return { status: "ambiguous", attempted: 0, delivered: 0, failed: 0, ambiguous: 1 };
    if (claimed?.kind === "cleared")
      return { status: "suppressed", attempted: 0, delivered: 0, failed: 0, ambiguous: 0 };
    if (claimed?.kind === "rate-limited")
      return {
        status: "rate-limited",
        attempted: 0,
        delivered: 0,
        failed: 0,
        ambiguous: 0,
        retryAfterMs: claimed.retryAfterMs,
      };
    const old = this.emissions.get(key);
    if (!this.options.ledger && old) return old.hash === hash ? old.result : failure();
    const rateKey = JSON.stringify([operatorKey, this.options.pluginId]);
    const starts = (this.rates.get(rateKey) ?? []).filter((start) => start > now - 60_000);
    if (!this.options.ledger && starts.length >= 12)
      return {
        status: "rate-limited",
        attempted: 0,
        delivered: 0,
        failed: 0,
        ambiguous: 0,
        retryAfterMs: starts[0]! + 60_000 - now,
      };
    if (!this.options.ledger) {
      starts.push(now);
      this.rates.set(rateKey, starts);
    }
    if (!targets.length) {
      const result = {
        status: "no-targets" as const,
        attempted: 0,
        delivered: 0,
        failed: 0,
        ambiguous: 0,
      };
      if (this.options.ledger) {
        this.options.ledger.completeEmission({
          principal,
          emissionId: c.emissionId,
          result,
          outcomes: new Map(),
          nowMs: now,
        });
      } else {
        this.emissions.set(key, { hash, result });
      }
      return result;
    }
    const payload: PluginNotificationTransportPayload = {
      version: 1,
      kind: "notify",
      tag: pluginNotificationOperationTopic(principal, c.logicalOperationId),
      expiresAtMs: c.expiresAtMs,
      ttlMs: Math.max(0, c.expiresAtMs - now),
      attentionClass: c.attentionClass,
      preview: c.preview,
      target: (() => {
        const destination = this.options.declaration.destinations.find(
          (entry) => entry.id === c.deepLink.destinationId,
        );
        // Candidate validation above guarantees this declaration-owned destination exists.
        if (!destination) return undefined;
        return {
          kind: "plugin-detail" as const,
          pluginId: this.options.pluginId,
          tabId: destination.tabId,
          destinationId: c.deepLink.destinationId,
          recordId: c.deepLink.recordId,
        };
      })(),
    };
    const values = await Promise.all(
      targets.map((target) =>
        sendWithinDeadline(
          c.expiresAtMs,
          () => this.options.now?.() ?? Date.now(),
          (options) =>
            this.options.transport.send(
              target,
              {
                ...payload,
                ttlMs: Math.max(0, c.expiresAtMs - (this.options.now?.() ?? Date.now())),
              },
              options,
            ),
        ),
      ),
    );
    const delivered = values.filter((x) => x === "accepted").length;
    const failed = values.filter((x) => x === "failed").length;
    const ambiguous = values.filter((x) => x === "ambiguous").length;
    const result = {
      status: (ambiguous
        ? "ambiguous"
        : delivered === targets.length
          ? "sent"
          : delivered
            ? "partial"
            : values.every((x) => x === "suppressed")
              ? "expired"
              : "failed") as PluginNotificationEmitResult["status"],
      attempted: targets.length,
      delivered,
      failed,
      ambiguous,
    };
    const outcomes = new Map(targets.map((target, index) => [target.id, values[index]!])) as Map<
      string,
      PluginNotificationAttemptOutcome
    >;
    if (this.options.ledger) {
      const reClearTargetIds = this.options.ledger.completeEmission({
        principal,
        emissionId: c.emissionId,
        result,
        outcomes,
        nowMs: this.options.now?.() ?? Date.now(),
      });
      if (reClearTargetIds.length > 0) {
        // A clear may win while this send is in flight. Reclaim the durable
        // clear attempts after recording acceptance so the remote alert cannot survive.
        await this.clear(principal, { version: 1, logicalOperationId: c.logicalOperationId });
      }
    } else {
      this.emissions.set(key, { hash, result });
    }
    const operationKey = JSON.stringify([operatorKey, c.logicalOperationId]);
    const all = this.targets.get(operationKey) ?? new Map();
    targets.forEach((target) => all.set(target.id, target));
    this.targets.set(operationKey, all);
    return result;
  }
  async clear(
    operator: string | PluginNotificationPrincipal,
    request: unknown,
  ): Promise<PluginNotificationClearResult> {
    if (!validClear(request))
      return { status: "partial", attempted: 0, cleared: 0, failed: 1, ambiguous: 0 };
    const principal =
      typeof operator === "string"
        ? principalForLegacyOperator(this.options.pluginId, operator)
        : operator;
    if (principal.pluginId !== this.options.pluginId)
      return { status: "partial", attempted: 0, cleared: 0, failed: 1, ambiguous: 0 };
    const operatorKey = principal.operatorId;
    const key = JSON.stringify([operatorKey, request.logicalOperationId]);
    const claimed = this.options.ledger?.claimClear({
      principal,
      logicalOperationId: request.logicalOperationId,
      nowMs: this.options.now?.() ?? Date.now(),
    });
    if (claimed?.kind === "replay") return claimed.result;
    if (claimed?.kind === "in-flight")
      return { status: "ambiguous", attempted: 0, cleared: 0, failed: 0, ambiguous: 1 };
    if (!this.options.ledger && this.cleared.has(key))
      return { status: "already-cleared", attempted: 0, cleared: 0, failed: 0, ambiguous: 0 };
    const targets = this.options.ledger
      ? claimed!.targetIds.map((id) => ({ id }))
      : [...(this.targets.get(key)?.values() ?? [])];
    if (!targets.length)
      return { status: "already-cleared", attempted: 0, cleared: 0, failed: 0, ambiguous: 0 };
    const payload: PluginNotificationTransportPayload = {
      version: 1,
      kind: "clear",
      tag: pluginNotificationOperationTopic(principal, request.logicalOperationId),
      expiresAtMs: this.options.now?.() ?? Date.now(),
      ttlMs: 0,
    };
    const values = await Promise.all(
      targets.map(async (target) => {
        const outcome = await sendWithinDeadline(
          (this.options.now?.() ?? Date.now()) + maximumTransportAttemptMs,
          () => this.options.now?.() ?? Date.now(),
          (options) => this.options.transport.clear(target, payload, options),
        );
        // Clears never have an expiry contract. A clock jump before the request starts
        // cannot prove a remote notification was removed, so preserve ambiguity.
        return outcome === "suppressed" ? "ambiguous" : outcome;
      }),
    );
    const priorCleared = claimed?.kind === "claimed" ? claimed.clearedTargetIds.length : 0;
    const cleared = priorCleared + values.filter((x) => x === "accepted").length;
    const failed = values.filter((x) => x === "failed").length;
    const ambiguous = values.filter((x) => x === "ambiguous").length;
    const result = {
      status: ambiguous ? "ambiguous" : failed ? "partial" : "cleared",
      attempted: priorCleared + targets.length,
      cleared,
      failed,
      ambiguous,
    };
    const outcomes = new Map(targets.map((target, index) => [target.id, values[index]!])) as Map<
      string,
      Exclude<PluginNotificationAttemptOutcome, "suppressed">
    >;
    if (this.options.ledger) {
      this.options.ledger.completeClear({
        principal,
        logicalOperationId: request.logicalOperationId,
        result,
        outcomes,
        nowMs: this.options.now?.() ?? Date.now(),
      });
    } else if (!failed && !ambiguous) {
      this.cleared.add(key);
    }
    return result;
  }
}

export function createPluginNotificationEmitter(params: {
  declaration: PluginNotificationDeclarationV1;
  coordinator: PluginNotificationCoordinator;
  isPluginActive(): boolean;
  isDeclarationActive?(): boolean;
  capturePrincipal?(): PluginNotificationPrincipal | undefined;
  isPrincipalCurrent?(principal: PluginNotificationPrincipal): boolean | Promise<boolean>;
}): PluginNotificationEmitter {
  return {
    bindCurrentOperator: () => {
      const client = getPluginRuntimeGatewayRequestScope()?.client;
      const principal = params.capturePrincipal?.();
      if (
        !(client?.authenticatedOperatorId ?? client?.authenticatedUserId) ||
        !params.isPluginActive() ||
        !principal
      )
        return undefined;
      const authorized = () =>
        params.isPluginActive() &&
        (params.isDeclarationActive?.() ?? true) &&
        params.declaration.requiredScopes.every((scope) => principal.scopes.includes(scope));
      if (!authorized()) return undefined;
      return {
        emit: async (candidate) => {
          const current = params.isPrincipalCurrent
            ? await params.isPrincipalCurrent(principal)
            : true;
          if (!authorized() || !current) return failure();
          return await params.coordinator.emit(principal, candidate);
        },
        clear: async (request) => {
          const current = params.isPrincipalCurrent
            ? await params.isPrincipalCurrent(principal)
            : true;
          if (!authorized() || !current)
            return { status: "partial", attempted: 0, cleared: 0, failed: 1, ambiguous: 0 };
          return await params.coordinator.clear(principal, request);
        },
      };
    },
  };
}
