import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "../api.js";
import { redactClaimToken } from "./card-redaction.js";
import type { GatewayMethodContext } from "./gateway-helpers.js";
import type { WorkboardStore } from "./store.js";

function readScope(params: Record<string, unknown>) {
  const { tenant, boardId, cardId } = params;
  if (
    typeof tenant !== "string" ||
    typeof boardId !== "string" ||
    !boardId.trim() ||
    typeof cardId !== "string" ||
    !cardId.trim()
  ) {
    throw new Error("Exact tenant, boardId and cardId are required.");
  }
  return { tenant, boardId, cardId };
}

function currentAuthority(request: GatewayMethodContext): () => void {
  const assertCurrent = request.sessionMutationAuthorization?.assertCurrent;
  if (!assertCurrent) {
    throw new Error("Result review requires current authenticated native authority.");
  }
  const assertSynchronous = () => {
    const result: unknown = assertCurrent();
    if (
      result &&
      (typeof result === "object" || typeof result === "function") &&
      typeof Reflect.get(result, "then") === "function"
    ) {
      throw new Error("Result review authority must be synchronous.");
    }
  };
  assertSynchronous();
  return assertSynchronous;
}

function requestId(params: Record<string, unknown>) {
  if (typeof params.requestId !== "string" || !params.requestId.trim()) {
    throw new Error("requestId is required.");
  }
  return params.requestId;
}

function revision(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

export function registerWorkboardResultReviewMethods(
  api: Pick<OpenClawPluginApi, "registerGatewayMethod">,
  store: WorkboardStore,
) {
  const methods: ReadonlyArray<
    readonly [
      string,
      "operator.read" | "operator.write",
      (request: GatewayMethodContext) => Promise<unknown>,
    ]
  > = [
    [
      "workboard.resultReviews.list",
      "operator.read",
      async (request) => ({
        requests: await store.listResultReviews(
          readScope(request.params),
          currentAuthority(request),
        ),
      }),
    ],
    [
      "workboard.resultReviews.get",
      "operator.read",
      async (request) => ({
        request: await store.getResultReview(
          { ...readScope(request.params), requestId: requestId(request.params) },
          currentAuthority(request),
        ),
      }),
    ],
    [
      "workboard.resultReviews.resolve",
      "operator.write",
      async (request) => {
        const assertCurrent = currentAuthority(request);
        const decision = request.params.decision;
        if (decision !== "reviewed" && decision !== "withdrawn") {
          throw new Error("decision must be reviewed or withdrawn.");
        }
        const result = await store.resolveResultReview(
          {
            ...readScope(request.params),
            requestId: requestId(request.params),
            expectedRevision: revision(request.params.expectedRevision, "expectedRevision"),
            expectedUpdatedAt: revision(request.params.expectedUpdatedAt, "expectedUpdatedAt"),
            decision,
          },
          assertCurrent,
        );
        assertCurrent();
        return { request: result.request, card: redactClaimToken(result.card) };
      },
    ],
  ];
  for (const [method, scope, handler] of methods) {
    api.registerGatewayMethod(
      method,
      async (request) => {
        try {
          const assertCurrent = currentAuthority(request);
          const result = await handler(request);
          // Private result proof and terminal receipts share this publication fence.
          assertCurrent();
          request.respond(true, result);
        } catch (error) {
          request.respond(false, undefined, {
            code: "workboard_error",
            message: formatErrorMessage(error),
          });
        }
      },
      { scope },
    );
  }
}
