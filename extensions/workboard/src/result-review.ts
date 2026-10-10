import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { WorkboardCard, WorkboardResultReviewRequest } from "@openclaw/workboard-contract";
import { cardBoardId, cardRunId, cardSessionKey } from "./store-card-helpers.js";
import type { WorkboardCompleteInput } from "./store-inputs.js";

const digest = (value: unknown) =>
  createHash("sha256").update(stableStringify(value)).digest("hex");

export function resultReviewCompletion(card: WorkboardCard, input: WorkboardCompleteInput) {
  const value = input.resultReview;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "logicalOperationId")
  )
    throw new Error("Result review requires one immutable logicalOperationId.");
  const operationId = Reflect.get(value, "logicalOperationId");
  if (typeof operationId !== "string" || !/^[a-zA-Z0-9._:-]{1,120}$/.test(operationId))
    throw new Error("Invalid result review operation identity.");
  if (
    typeof input.expectedUpdatedAt !== "number" ||
    !Number.isSafeInteger(input.expectedUpdatedAt) ||
    input.expectedUpdatedAt < 0
  )
    throw new Error("Result review requires the original card revision.");
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "ownerId",
          "token",
          "summary",
          "proof",
          "proofId",
          "artifacts",
          "createdCardIds",
          "expectedUpdatedAt",
          "resultReview",
          "id",
        ].includes(key),
    )
  )
    throw new Error("Unexpected result review completion input.");
  const sessionKey = cardSessionKey(card),
    runId = cardRunId(card);
  if (!sessionKey || !runId)
    throw new Error("Result review requires an exact producing Session and run.");
  const scope = {
    tenant: card.metadata?.automation?.tenant ?? "",
    boardId: cardBoardId(card),
    cardId: card.id,
    sessionKey,
    runId,
  };
  const intent = {
    ...scope,
    logicalOperationId: operationId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    summary: input.summary ?? null,
    proof: input.proof ?? null,
    proofId: input.proofId ?? null,
    artifacts: input.artifacts ?? null,
    createdCardIds: input.createdCardIds ?? null,
  };
  if (Buffer.byteLength(stableStringify(intent)) > 64 * 1024)
    throw new Error("Result review completion exceeds the supported bound.");
  return {
    expectedUpdatedAt: input.expectedUpdatedAt,
    identity: {
      ...scope,
      id: `result-review:${digest({ tenant: scope.tenant, boardId: scope.boardId, cardId: scope.cardId, operationId })}`,
      completionIntent: digest(intent),
    },
  };
}

export function createResultReviewRequest(
  card: WorkboardCard,
  input: WorkboardCompleteInput,
  result: WorkboardResultReviewRequest["result"],
  createdAt: number,
): WorkboardResultReviewRequest {
  const { identity } = resultReviewCompletion(card, input);
  if (!result.summary.trim())
    throw new Error("An explicit result review requires a concrete completion summary.");
  const snapshot = structuredClone(result);
  if (Buffer.byteLength(stableStringify(snapshot)) > 128 * 1024)
    throw new Error("Result review snapshot exceeds the supported bound.");
  const resultDigest = digest(snapshot);
  return {
    schemaVersion: 1,
    ...identity,
    requestRevision: digest({ ...identity, resultDigest }),
    resultDigest,
    revision: 1,
    status: "pending",
    createdAt,
    expiresAt: null,
    resolvedAt: null,
    result: snapshot,
  };
}

export function assertResultReviewScope(
  card: WorkboardCard,
  scope: { tenant: string; boardId: string; cardId: string },
) {
  if (
    scope.cardId !== card.id ||
    scope.boardId !== cardBoardId(card) ||
    scope.tenant !== (card.metadata?.automation?.tenant ?? "")
  )
    throw new Error("The exact result review card scope changed.");
}

export function synchronousResultReviewAuthority(
  assertCurrent: (() => void) | undefined,
): () => void {
  if (!assertCurrent) throw new Error("Result review requires current native authority.");
  return () => {
    const result: unknown = assertCurrent();
    if (
      result &&
      (typeof result === "object" || typeof result === "function") &&
      typeof Reflect.get(result, "then") === "function"
    )
      throw new Error("Result review authority must be synchronous.");
  };
}
