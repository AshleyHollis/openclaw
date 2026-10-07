import { types } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  PreparedSessionTranscriptSourceAdmission,
  SessionTranscriptSourceSelection,
} from "../config/sessions/session-transcript-source-admission.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type {
  GatewayRequestOptions,
  SessionMutationAuthorization,
} from "./server-methods/types.js";

export const SESSION_TRANSCRIPT_GATEWAY_SOURCE_ADMISSION_VERSION = 1;

/** Refuse legacy/injected transports before invoking a source-bound request. */
export function assertSessionTranscriptGatewaySourceAdmissionAvailable(gateway: {
  readonly sessionTranscriptSourceAdmissionVersion?: number;
}): void {
  if (
    gateway.sessionTranscriptSourceAdmissionVersion !==
    SESSION_TRANSCRIPT_GATEWAY_SOURCE_ADMISSION_VERSION
  ) {
    throw new Error("Gateway host does not support transcript source admission version 1");
  }
}

/** Host-only sideband; neither the closure nor native custody belongs to RPC JSON. */
export type SessionTranscriptGatewaySource = Readonly<{
  selection: SessionTranscriptSourceSelection;
  assertCurrent: () => void;
}>;

export function assertSessionTranscriptGatewaySource(
  method: string,
  source: SessionTranscriptGatewaySource,
): void {
  if (method !== "workboard.cards.create") {
    throw new Error("Transcript source admission only supports workboard.cards.create");
  }
  if (typeof source?.assertCurrent !== "function" || types.isAsyncFunction(source.assertCurrent)) {
    throw new Error("Transcript source handoff requires synchronous captured authority");
  }
  const result: unknown = source.assertCurrent();
  if (isPromiseLike(result)) {
    void Promise.resolve(result).catch(() => {});
    throw new Error("Transcript source handoff requires synchronous captured authority");
  }
  if (!source.selection || isIncognitoSessionKey(source.selection.sessionKey)) {
    throw new Error("Transcript source handoff requires a non-incognito source selection");
  }
}

/** Private router lifetime; capture the sideband once before any caller callback. */
export function createGatewaySessionTranscriptSourceHandoffOwner(request: GatewayRequestOptions) {
  const client = request.client;
  const userId = client?.authenticatedUserId;
  const profileId = client?.authenticatedUserProfile?.profileId;
  const connId = client?.connId;
  const assertRequesterCurrent = () => {
    if (
      request.client !== client ||
      client?.authenticatedUserId !== userId ||
      client?.authenticatedUserProfile?.profileId !== profileId ||
      client?.connId !== connId
    ) {
      throw new Error("Transcript source handoff requester identity changed");
    }
  };
  const supplied = request.sessionTranscriptSource;
  const originalGuard = supplied?.assertCurrent;
  const asyncGuard = typeof originalGuard === "function" && types.isAsyncFunction(originalGuard);
  const guard = typeof originalGuard === "function" ? originalGuard.bind(supplied) : originalGuard;
  const source =
    supplied === undefined
      ? undefined
      : Object.freeze({
          selection: Object.freeze({ ...supplied.selection }),
          assertCurrent:
            typeof guard === "function"
              ? () => {
                  assertRequesterCurrent();
                  const result: unknown = guard();
                  if (isPromiseLike(result)) {
                    void Promise.resolve(result).catch(() => {});
                  }
                  assertRequesterCurrent();
                  return result;
                }
              : supplied.assertCurrent,
        });
  const validate = () => {
    if (source !== undefined) {
      if (asyncGuard) {
        throw new Error("Transcript source handoff requires synchronous captured authority");
      }
      assertSessionTranscriptGatewaySource(request.req.method, source);
    }
  };
  let handoff: Awaited<ReturnType<typeof prepareGatewaySessionTranscriptSourceHandoff>> | undefined;
  return {
    validate,
    async prepare(authorization: SessionMutationAuthorization | undefined) {
      if (source === undefined || handoff) {
        return;
      }
      if (!authorization) {
        throw new Error("Transcript source handoff requires authenticated mutation authority");
      }
      validate();
      handoff = await prepareGatewaySessionTranscriptSourceHandoff(
        request,
        source,
        authorization.assertCurrent,
      );
    },
    get take() {
      return handoff?.take;
    },
    async close(settle: () => void) {
      try {
        await handoff?.close();
      } finally {
        settle();
      }
    },
  };
}

/** The authenticated router owns preparation, transfer and settlement of this invocation. */
export async function prepareGatewaySessionTranscriptSourceHandoff(
  request: GatewayRequestOptions,
  source: SessionTranscriptGatewaySource,
  assertWriteCurrent: () => void,
) {
  const client = request.client;
  const userId = client?.authenticatedUserId;
  const profileId = client?.authenticatedUserProfile?.profileId;
  const connId = client?.connId;
  assertSessionTranscriptGatewaySource(request.req.method, source);
  const selection = Object.freeze({ ...source.selection });
  const create = asOptionalRecord(request.req.params);
  if (create?.sessionKey !== selection.sessionKey || create.agentId !== selection.agentId) {
    throw new Error("Transcript source handoff must match the exact card Session and agent");
  }
  const assertCaller = source.assertCurrent.bind(source);
  const envelope = request.req;
  const input = envelope.params;
  const params = JSON.stringify(request.req.params);
  let active = true;
  let transferred = false;
  const assertInvocation = () => {
    if (
      !active ||
      request.req !== envelope ||
      envelope.params !== input ||
      JSON.stringify(envelope.params) !== params
    ) {
      throw new Error("Transcript source handoff invocation changed or settled");
    }
    request.signal?.throwIfAborted();
    assertWriteCurrent();
    assertSessionTranscriptGatewaySource(request.req.method, {
      selection,
      assertCurrent: assertCaller,
    });
    assertWriteCurrent();
    if (
      request.client !== client ||
      client?.authenticatedUserId !== userId ||
      client?.authenticatedUserProfile?.profileId !== profileId ||
      client?.connId !== connId
    ) {
      throw new Error("Transcript source handoff requester identity changed");
    }
  };
  const { prepareGatewaySessionAccessAuthority } = await import("./session-access-authority.js");
  const readAuthority = await prepareGatewaySessionAccessAuthority({
    policy: { mode: "read" },
    requestParams: { sessionKey: selection.sessionKey, agentId: selection.agentId },
    client: request.client,
    context: request.context,
    ownSessionOnly: false,
    hasCurrentClientAuthority: request.hasCurrentClientAuthority,
    assertInvocationCurrent: assertInvocation,
  });
  let capability: PreparedSessionTranscriptSourceAdmission | undefined;
  try {
    if (readAuthority.target.sessionId !== selection.sessionId) {
      throw new Error("Transcript source Session changed before handoff");
    }
    const assertCurrent = () => {
      assertInvocation();
      readAuthority.assertCurrent();
    };
    assertCurrent();
    const { prepareSessionTranscriptSourceAdmission } =
      await import("../config/sessions/session-transcript-source-admission.js");
    capability = await prepareSessionTranscriptSourceAdmission(selection, {
      assertCurrent,
      signal: request.signal,
      config: request.context.getRuntimeConfig(),
    });
    assertCurrent();
    const retained = capability;
    return {
      take(): PreparedSessionTranscriptSourceAdmission {
        assertCurrent();
        if (transferred) {
          throw new Error("Transcript source handoff was already transferred");
        }
        transferred = true;
        return retained;
      },
      async close() {
        active = false;
        try {
          await retained.close();
        } finally {
          readAuthority.release();
        }
      },
    };
  } catch (error) {
    try {
      await capability?.close();
    } finally {
      readAuthority.release();
    }
    throw error;
  }
}
