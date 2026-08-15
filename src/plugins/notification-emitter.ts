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
export type PluginNotificationTransportPayload = {
  version: 1;
  kind: "notify" | "clear";
  tag: string;
  expiresAtMs: number;
  attentionClass?: "active" | "time-sensitive";
  preview?: { title: string; body: string };
  target?: { kind: "plugin-detail"; destinationId: string; recordId: string };
};
export type PluginNotificationTransport = {
  send(
    target: PluginNotificationTarget,
    payload: PluginNotificationTransportPayload,
  ): Promise<"accepted" | "failed" | "ambiguous" | "suppressed">;
  clear(
    target: PluginNotificationTarget,
    payload: PluginNotificationTransportPayload,
  ): Promise<"accepted" | "failed" | "ambiguous">;
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
    resolveTab: (pluginId: string, tabId: string) => boolean;
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
      (destinationIds.add(destination.id), params.resolveTab(params.pluginId, destination.tabId)),
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
export const pluginNotificationOperationTopic = (id: string) =>
  createHash("sha256").update(id).digest("base64url").slice(0, 32);
const validClear = (value: unknown): value is PluginNotificationClearV1 =>
  plain(value) &&
  keys(value, ["version", "logicalOperationId"]) &&
  value.version === 1 &&
  typeof value.logicalOperationId === "string" &&
  ID.test(value.logicalOperationId);

/** Process coordinator; durable ledger is supplied by the host's stored implementation. */
export class PluginNotificationCoordinator {
  private emissions = new Map<string, { hash: string; result: PluginNotificationEmitResult }>();
  private rates = new Map<string, number[]>();
  private targets = new Map<string, Map<string, PluginNotificationTarget>>();
  private cleared = new Set<string>();
  constructor(
    private readonly options: {
      pluginId: string;
      declaration: PluginNotificationDeclarationV1;
      targets(operatorKey: string): readonly PluginNotificationTarget[];
      transport: PluginNotificationTransport;
      now?: () => number;
    },
  ) {}
  async emit(operatorKey: string, candidate: unknown): Promise<PluginNotificationEmitResult> {
    const now = this.options.now?.() ?? Date.now();
    if (!validatePluginNotificationCandidate(candidate, this.options.declaration, now))
      return failure();
    const c = candidate;
    const key = JSON.stringify([operatorKey, this.options.pluginId, c.emissionId]);
    const hash = createHash("sha256").update(canonical(c)).digest("hex");
    const old = this.emissions.get(key);
    if (old) return old.hash === hash ? old.result : failure();
    const rateKey = JSON.stringify([operatorKey, this.options.pluginId]);
    const starts = (this.rates.get(rateKey) ?? []).filter((start) => start > now - 60_000);
    if (starts.length >= 12)
      return {
        status: "rate-limited",
        attempted: 0,
        delivered: 0,
        failed: 0,
        ambiguous: 0,
        retryAfterMs: starts[0]! + 60_000 - now,
      };
    starts.push(now);
    this.rates.set(rateKey, starts);
    const targets = this.options.targets(operatorKey);
    if (!targets.length) {
      const result = {
        status: "no-targets" as const,
        attempted: 0,
        delivered: 0,
        failed: 0,
        ambiguous: 0,
      };
      this.emissions.set(key, { hash, result });
      return result;
    }
    const payload: PluginNotificationTransportPayload = {
      version: 1,
      kind: "notify",
      tag: pluginNotificationOperationTopic(c.logicalOperationId),
      expiresAtMs: c.expiresAtMs,
      attentionClass: c.attentionClass,
      preview: c.preview,
      target: c.deepLink,
    };
    const values = await Promise.all(
      targets.map(async (target) => {
        try {
          return c.expiresAtMs <= (this.options.now?.() ?? Date.now())
            ? ("suppressed" as const)
            : await this.options.transport.send(target, payload);
        } catch {
          return "ambiguous" as const;
        }
      }),
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
              ? "suppressed"
              : "failed") as PluginNotificationEmitResult["status"],
      attempted: targets.length,
      delivered,
      failed,
      ambiguous,
    };
    this.emissions.set(key, { hash, result });
    const operationKey = JSON.stringify([operatorKey, c.logicalOperationId]);
    const all = this.targets.get(operationKey) ?? new Map();
    targets.forEach((target) => all.set(target.id, target));
    this.targets.set(operationKey, all);
    return result;
  }
  async clear(operatorKey: string, request: unknown): Promise<PluginNotificationClearResult> {
    if (!validClear(request))
      return { status: "partial", attempted: 0, cleared: 0, failed: 1, ambiguous: 0 };
    const key = JSON.stringify([operatorKey, request.logicalOperationId]);
    if (this.cleared.has(key))
      return { status: "already-cleared", attempted: 0, cleared: 0, failed: 0, ambiguous: 0 };
    const targets = [...(this.targets.get(key)?.values() ?? [])];
    if (!targets.length)
      return { status: "already-cleared", attempted: 0, cleared: 0, failed: 0, ambiguous: 0 };
    const payload: PluginNotificationTransportPayload = {
      version: 1,
      kind: "clear",
      tag: pluginNotificationOperationTopic(request.logicalOperationId),
      expiresAtMs: this.options.now?.() ?? Date.now(),
    };
    const values = await Promise.all(
      targets.map(async (target) => {
        try {
          return await this.options.transport.clear(target, payload);
        } catch {
          return "ambiguous" as const;
        }
      }),
    );
    const cleared = values.filter((x) => x === "accepted").length;
    const failed = values.filter((x) => x === "failed").length;
    const ambiguous = values.filter((x) => x === "ambiguous").length;
    if (!failed && !ambiguous) this.cleared.add(key);
    return {
      status: ambiguous ? "ambiguous" : failed ? "partial" : "cleared",
      attempted: targets.length,
      cleared,
      failed,
      ambiguous,
    };
  }
}

export function createPluginNotificationEmitter(params: {
  declaration: PluginNotificationDeclarationV1;
  coordinator: PluginNotificationCoordinator;
  isPluginActive(): boolean;
}): PluginNotificationEmitter {
  return {
    bindCurrentOperator: () => {
      const client = getPluginRuntimeGatewayRequestScope()?.client;
      if (!client?.authenticatedUserId || !params.isPluginActive()) return undefined;
      const authorized = () =>
        params.isPluginActive() &&
        !client.invalidated &&
        params.declaration.requiredScopes.every((scope) => client.connect.scopes.includes(scope));
      if (!authorized()) return undefined;
      return {
        emit: async (candidate) =>
          authorized()
            ? params.coordinator.emit(client.authenticatedUserId!, candidate)
            : failure(),
        clear: async (request) =>
          authorized()
            ? params.coordinator.clear(client.authenticatedUserId!, request)
            : { status: "partial", attempted: 0, cleared: 0, failed: 1, ambiguous: 0 },
      };
    },
  };
}
