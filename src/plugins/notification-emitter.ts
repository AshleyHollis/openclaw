// Host-owned, closed notification candidate contract. No credential-bearing type is exported.
import { createHash } from "node:crypto";
import { isOperatorScope, type OperatorScope } from "../gateway/operator-scopes.js";
import { boundedText, canonical, failure, keys, plain } from "./notification-emitter-validation.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DAY = 86_400_000;
export type PluginNotificationDeclarationV1 = {
  version: 1;
  id: string;
  requiredScopes: OperatorScope[];
  destinations: Array<{ id: string; pageId: string }>;
};
export type PluginNotificationCandidateV1 = {
  version: 1;
  /** Unique per operator/plugin, across declarations; retries must retain the declaration. */
  emissionId: string;
  /** Clearing closes this operator/plugin-wide operation across all its declarations. */
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
  /** Stable host runtime identity; never provided by a plugin candidate. */
  sourceId: string;
  tag: string;
  expiresAtMs: number;
  /** Remaining delivery lifetime, bounded by the host immediately before I/O. */
  ttlMs: number;
  attentionClass?: "active" | "time-sensitive";
  preview?: { title: string; body: string };
  target?: {
    kind: "plugin-detail";
    pluginId: string;
    pageId: string;
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

type PluginNotificationAttemptOutcome = "accepted" | "failed" | "ambiguous" | "suppressed";
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
    | {
        kind: "claimed";
        attemptId: string;
        targetIds: readonly string[];
        clearedTargetIds: readonly string[];
      }
    | { kind: "replay"; result: PluginNotificationClearResult }
    | { kind: "in-flight" };
  completeClear(params: {
    principal: PluginNotificationPrincipal;
    logicalOperationId: string;
    attemptId: string;
    outcomes: ReadonlyMap<string, Exclude<PluginNotificationAttemptOutcome, "suppressed">>;
    nowMs: number;
  }): PluginNotificationClearResult;
};

export function validatePluginNotificationDeclaration(
  value: unknown,
  params: {
    pluginId: string;
    existingCount: number;
    resolvePage?: (pluginId: string, pageId: string) => boolean;
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
  ) {
    return false;
  }
  const destinationIds = new Set<string>();
  return value.destinations.every(
    (destination) =>
      plain(destination) &&
      keys(destination, ["id", "pageId"]) &&
      typeof destination.id === "string" &&
      typeof destination.pageId === "string" &&
      ID.test(destination.id) &&
      ID.test(destination.pageId) &&
      !destinationIds.has(destination.id) &&
      (destinationIds.add(destination.id),
      params.resolvePage === undefined || params.resolvePage(params.pluginId, destination.pageId)),
  );
}

/**
 * Copy every candidate field while it is still untrusted. The plugin can retain
 * and mutate its input after emit(), so validation and delivery must share this
 * host-owned plain snapshot rather than the plugin's object graph.
 */
function snapshotPluginNotificationCandidate(value: unknown): unknown {
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
    ])
  ) {
    return undefined;
  }
  const preview = value.preview;
  const deepLink = value.deepLink;
  if (
    !plain(preview) ||
    !keys(preview, ["title", "body"]) ||
    !plain(deepLink) ||
    !keys(deepLink, ["kind", "destinationId", "recordId"])
  ) {
    return undefined;
  }
  return {
    version: value.version,
    emissionId: value.emissionId,
    logicalOperationId: value.logicalOperationId,
    attentionClass: value.attentionClass,
    preview: { title: preview.title, body: preview.body },
    deepLink: {
      kind: deepLink.kind,
      destinationId: deepLink.destinationId,
      recordId: deepLink.recordId,
    },
    expiresAtMs: value.expiresAtMs,
  };
}

function isValidPluginNotificationCandidateSnapshot(
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
    (value.attentionClass !== "active" && value.attentionClass !== "time-sensitive")
  ) {
    return false;
  }
  const preview = value.preview;
  if (
    !plain(preview) ||
    !keys(preview, ["title", "body"]) ||
    !boundedText(preview.title, 80) ||
    !boundedText(preview.body, 256)
  ) {
    return false;
  }
  const deepLink = value.deepLink;
  if (
    !plain(deepLink) ||
    !keys(deepLink, ["kind", "destinationId", "recordId"]) ||
    deepLink.kind !== "plugin-detail" ||
    typeof deepLink.destinationId !== "string" ||
    typeof deepLink.recordId !== "string" ||
    !ID.test(deepLink.destinationId) ||
    !ID.test(deepLink.recordId) ||
    !declaration.destinations.some((destination) => destination.id === deepLink.destinationId)
  ) {
    return false;
  }
  const expiresAtMs = value.expiresAtMs;
  if (
    typeof expiresAtMs !== "number" ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= nowMs ||
    expiresAtMs > nowMs + DAY
  ) {
    return false;
  }
  // SAFETY: the closed key and field checks above establish the complete v1 candidate shape.
  return Buffer.byteLength(canonical(value as PluginNotificationCandidateV1), "utf8") <= 2048;
}

function validatePluginNotificationCandidate(
  value: unknown,
  declaration: PluginNotificationDeclarationV1,
  nowMs = Date.now(),
): value is PluginNotificationCandidateV1 {
  const snapshot = snapshotPluginNotificationCandidate(value);
  return (
    snapshot !== undefined &&
    isValidPluginNotificationCandidateSnapshot(snapshot, declaration, nowMs)
  );
}
const pluginNotificationOperationTopic = (
  principal: Pick<PluginNotificationPrincipal, "operatorId" | "pluginId">,
  logicalOperationId: string,
  sourceId: string,
) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        sourceId,
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

function resolveTransportSourceId(read: () => string): string | undefined {
  try {
    const sourceId = read();
    return typeof sourceId === "string" && ID.test(sourceId) ? sourceId : undefined;
  } catch {
    return undefined;
  }
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
  if (remainingMs <= 0) {
    return null;
  }
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
  if (!deadline) {
    return "suppressed";
  }
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

/** Claims durable operations before transport; uncertain emissions are never sent twice. */
export class PluginNotificationCoordinator {
  constructor(
    private readonly options: {
      pluginId: string;
      declaration: PluginNotificationDeclarationV1;
      targets(principal: PluginNotificationPrincipal): readonly PluginNotificationTarget[];
      transport: PluginNotificationTransport;
      transportSourceId(): string;
      now?: () => number;
      ledger: PluginNotificationLedger;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }

  async emit(
    principal: PluginNotificationPrincipal,
    candidate: unknown,
  ): Promise<PluginNotificationEmitResult> {
    const c = snapshotPluginNotificationCandidate(candidate);
    const now = this.now();
    if (
      !validatePluginNotificationCandidate(c, this.options.declaration, now) ||
      principal.pluginId !== this.options.pluginId
    ) {
      return failure();
    }
    const sourceId = resolveTransportSourceId(() => this.options.transportSourceId());
    if (!sourceId) {
      return failure();
    }
    const targets = this.options.targets(principal);
    const claimed = this.options.ledger.claimEmission({
      principal,
      declarationId: this.options.declaration.id,
      emissionId: c.emissionId,
      logicalOperationId: c.logicalOperationId,
      candidateHash: createHash("sha256").update(canonical(c)).digest("hex"),
      expiresAtMs: c.expiresAtMs,
      targetIds: targets.map((target) => target.id),
      nowMs: now,
    });
    switch (claimed.kind) {
      case "replay":
        return claimed.result;
      case "conflict":
        return failure();
      case "in-flight":
        return { status: "ambiguous", attempted: 0, delivered: 0, failed: 0, ambiguous: 1 };
      case "cleared":
        return { status: "suppressed", attempted: 0, delivered: 0, failed: 0, ambiguous: 0 };
      case "rate-limited":
        return {
          status: "rate-limited",
          attempted: 0,
          delivered: 0,
          failed: 0,
          ambiguous: 0,
          retryAfterMs: claimed.retryAfterMs,
        };
      case "claimed":
        break;
    }
    const destination = this.options.declaration.destinations.find(
      (entry) => entry.id === c.deepLink.destinationId,
    );
    if (!destination) {
      return failure();
    }
    const payload: PluginNotificationTransportPayload = {
      version: 1,
      kind: "notify",
      sourceId,
      tag: pluginNotificationOperationTopic(principal, c.logicalOperationId, sourceId),
      expiresAtMs: c.expiresAtMs,
      ttlMs: c.expiresAtMs - now,
      attentionClass: c.attentionClass,
      preview: c.preview,
      target: {
        kind: "plugin-detail",
        pluginId: this.options.pluginId,
        pageId: destination.pageId,
        destinationId: destination.id,
        recordId: c.deepLink.recordId,
      },
    };
    const outcomes = new Map<string, PluginNotificationAttemptOutcome>(
      await Promise.all(
        claimed.targetIds.map(
          async (id) =>
            [
              id,
              await sendWithinDeadline(
                c.expiresAtMs,
                () => this.now(),
                (options) =>
                  this.options.transport.send(
                    { id },
                    { ...payload, ttlMs: Math.max(0, c.expiresAtMs - this.now()) },
                    options,
                  ),
              ),
            ] as const,
        ),
      ),
    );
    const values = [...outcomes.values()];
    const delivered = values.filter((value) => value === "accepted").length;
    const failed = values.filter((value) => value === "failed").length;
    const ambiguous = values.filter((value) => value === "ambiguous").length;
    const result: PluginNotificationEmitResult = {
      status: !values.length
        ? "no-targets"
        : ambiguous
          ? "ambiguous"
          : delivered === values.length
            ? "sent"
            : delivered
              ? "partial"
              : failed
                ? "failed"
                : "suppressed",
      attempted: values.length,
      delivered,
      failed,
      ambiguous,
    };
    const reClear = this.options.ledger.completeEmission({
      principal,
      emissionId: c.emissionId,
      result,
      outcomes,
      nowMs: this.now(),
    });
    // A clear can commit while transport awaits. Re-clear late acceptance before returning.
    if (reClear.length) {
      await this.clear(principal, { version: 1, logicalOperationId: c.logicalOperationId });
    }
    return result;
  }

  async clear(
    principal: PluginNotificationPrincipal,
    request: unknown,
  ): Promise<PluginNotificationClearResult> {
    if (!validClear(request) || principal.pluginId !== this.options.pluginId) {
      return { status: "partial", attempted: 0, cleared: 0, failed: 1, ambiguous: 0 };
    }
    const sourceId = resolveTransportSourceId(() => this.options.transportSourceId());
    if (!sourceId) {
      return { status: "partial", attempted: 0, cleared: 0, failed: 1, ambiguous: 0 };
    }
    const claimed = this.options.ledger.claimClear({
      principal,
      logicalOperationId: request.logicalOperationId,
      nowMs: this.now(),
    });
    if (claimed.kind === "replay") {
      return claimed.result;
    }
    if (claimed.kind === "in-flight") {
      return { status: "ambiguous", attempted: 0, cleared: 0, failed: 0, ambiguous: 1 };
    }
    const payload: PluginNotificationTransportPayload = {
      version: 1,
      kind: "clear",
      sourceId,
      tag: pluginNotificationOperationTopic(principal, request.logicalOperationId, sourceId),
      expiresAtMs: this.now(),
      ttlMs: 0,
    };
    const outcomes = new Map<string, Exclude<PluginNotificationAttemptOutcome, "suppressed">>(
      await Promise.all(
        claimed.targetIds.map(async (id) => {
          const outcome = await sendWithinDeadline(
            this.now() + maximumTransportAttemptMs,
            () => this.now(),
            (options) => this.options.transport.clear({ id }, payload, options),
          );
          return [id, outcome === "suppressed" ? "ambiguous" : outcome] as const;
        }),
      ),
    );
    // A newer clear may supersede this transport attempt while it awaits.
    // Only the durable owner can report the current operation's outcome.
    return this.options.ledger.completeClear({
      principal,
      logicalOperationId: request.logicalOperationId,
      attemptId: claimed.attemptId,
      outcomes,
      nowMs: this.now(),
    });
  }
}
