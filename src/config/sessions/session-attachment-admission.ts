import { createHash } from "node:crypto";
import { types } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { parseInboundMediaUri } from "../../media/inbound-media-uri.js";
import { prepareInboundOriginalCustody } from "../../media/inbound-original-custody.js";
import { getMediaDir, readMediaBuffer } from "../../media/store.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { bindSessionTranscriptStoreScope } from "./session-accessor.transcript-target.js";
import {
  AcceptedSessionAttachmentPublicationError,
  type AcceptedSessionAttachmentAdmission,
  type AcceptedSessionAttachmentSelection,
  type AcceptedSessionAttachmentEffectState,
} from "./session-attachment-admission.types.js";
import type { AcceptedAttachmentSourceRead } from "./session-attachment-admission.worker.js";
import {
  prepareSessionTranscriptSourceAdmission,
  publishSessionTranscriptSourceAdmissionEffect,
} from "./session-transcript-source-admission.js";

export const ACCEPTED_SESSION_ATTACHMENT_ADMISSION_VERSION = 1;
export const ACCEPTED_SESSION_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** Captured host authority, never a serialized attachment assertion or filesystem locator. */
export type AcceptedSessionAttachmentAuthority = Readonly<{
  assertCurrent(selection: AcceptedSessionAttachmentSelection): void;
  signal?: AbortSignal;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}>;

export async function prepareAcceptedSessionAttachmentAdmission(
  input: AcceptedSessionAttachmentSelection,
  capturedNativeAuthority: AcceptedSessionAttachmentAuthority,
): Promise<AcceptedSessionAttachmentAdmission> {
  if (
    typeof capturedNativeAuthority?.assertCurrent !== "function" ||
    types.isAsyncFunction(capturedNativeAuthority.assertCurrent)
  ) {
    throw new Error(
      "Accepted attachment preparation requires synchronous captured native authority",
    );
  }
  const selection = Object.freeze({
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    entryId: input.entryId,
    generation: input.generation,
    mediaIndex: input.mediaIndex,
    mediaRef: input.mediaRef,
  });
  for (const value of [
    selection.agentId,
    selection.sessionKey,
    selection.sessionId,
    selection.entryId,
    selection.generation,
    selection.mediaRef,
  ]) {
    if (typeof value !== "string" || !value.trim() || value.length > 4096) {
      throw new Error("Accepted attachment identity is invalid");
    }
  }
  if (
    !Number.isSafeInteger(selection.mediaIndex) ||
    selection.mediaIndex < 0 ||
    !parseInboundMediaUri(selection.mediaRef)
  ) {
    throw new Error("Accepted attachment index or inbound reference is invalid");
  }
  if (isIncognitoSessionKey(selection.sessionKey)) {
    throw new Error("Incognito transcripts cannot be re-persisted");
  }
  const agentId = normalizeAgentId(selection.agentId);
  if (parseAgentSessionKey(selection.sessionKey)?.agentId !== agentId) {
    throw new Error("Accepted attachment Session does not belong to its exact agent");
  }
  const nativeAssert = capturedNativeAuthority.assertCurrent.bind(capturedNativeAuthority);
  const signal = capturedNativeAuthority.signal;
  const env = { ...(capturedNativeAuthority.env ?? process.env) };
  const mediaRoot = getMediaDir(env);
  const assertInvocation = () => {
    signal?.throwIfAborted();
    const result: unknown = nativeAssert(selection);
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new Error("Accepted attachment authority must be synchronous");
    }
    if (getMediaDir(env) !== mediaRoot) {
      throw new Error("Accepted attachment native media owner changed");
    }
  };
  assertInvocation();
  const scope = bindSessionTranscriptStoreScope(
    { agentId, sessionKey: selection.sessionKey, sessionId: selection.sessionId, env },
    capturedNativeAuthority.config,
  );
  const owner = await loadSessionEntryForAdmission(scope, {
    assertCurrent: assertInvocation,
    signal,
  });
  let sourceRead: AcceptedAttachmentSourceRead | undefined;
  let source: Awaited<ReturnType<typeof prepareSessionTranscriptSourceAdmission>> | undefined;
  let handoffFailure: { error: unknown } | undefined;
  let sourceCloseAttempted = false;
  try {
    assertInvocation();
    if (
      !owner.databaseOptions ||
      !owner.execution ||
      owner.entry?.sessionId !== selection.sessionId
    ) {
      throw new Error("Accepted attachment Session is unavailable or replaced");
    }
    const execution = owner.execution;
    const originalIdentity = execution.fileIdentity;
    const assertOriginalSource = () => {
      const current = readDatabasePathIdentitySync(execution.path);
      if (
        !originalIdentity ||
        current.key !== `file:${originalIdentity.physicalIdentity}` ||
        current.canonicalPath !== originalIdentity.nativeLocation ||
        current.birthtime !== originalIdentity.birthtime
      ) {
        throw new Error("Accepted attachment source database changed during ownership handoff");
      }
    };
    const assertOwner = () => {
      assertInvocation();
      owner.databaseClaim.assertCurrent();
      execution.assertCurrent();
      assertOriginalSource();
    };
    assertOwner();
    const store = await openOpenClawAgentSqliteWorkerStore<{
      read: { input: undefined; output: AcceptedAttachmentSourceRead };
    }>(
      owner.databaseOptions,
      { execution: owner.execution },
      {
        moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionAttachmentAdmission),
        input: { scope: resolveSqliteTranscriptScope(scope), selection, mediaRoot },
      },
    );
    try {
      sourceRead = await store.execute({ type: "read", input: undefined }, assertOwner, { signal });
    } finally {
      await store.close();
    }
    assertOwner();
    // Retain the selected reader until the publication owner has acquired the same native file.
    source = await prepareSessionTranscriptSourceAdmission(
      {
        agentId,
        sessionKey: selection.sessionKey,
        sessionId: selection.sessionId,
        entryId: selection.entryId,
        generation: selection.generation,
        digest: sourceRead.digest,
      },
      { assertCurrent: assertInvocation, signal, config: capturedNativeAuthority.config, env },
    );
    assertOwner();
  } catch (error) {
    handoffFailure = { error };
    sourceCloseAttempted = true;
    try {
      await source?.close();
    } catch (cleanupError) {
      handoffFailure = { error: new AggregateError([error, cleanupError]) };
    }
  } finally {
    try {
      await owner.databaseClaim.release();
    } catch (error) {
      handoffFailure = {
        error: handoffFailure ? new AggregateError([handoffFailure.error, error]) : error,
      };
    }
  }
  if (handoffFailure) {
    if (!sourceCloseAttempted) {
      try {
        await source?.close();
      } catch (cleanupError) {
        handoffFailure = { error: new AggregateError([handoffFailure.error, cleanupError]) };
      }
    }
    throw handoffFailure.error;
  }
  const retainedSource = source;
  if (!retainedSource || !sourceRead) {
    throw new Error("Accepted attachment source admission is unavailable");
  }
  let custody: Awaited<ReturnType<typeof prepareInboundOriginalCustody>>;
  try {
    assertInvocation();
    const original = await readMediaBuffer(
      sourceRead.mediaId,
      "inbound",
      ACCEPTED_SESSION_ATTACHMENT_MAX_BYTES,
      { env },
    );
    assertInvocation();
    custody = await prepareInboundOriginalCustody(
      {
        mediaRoot,
        mediaId: sourceRead.mediaId,
        digest: `sha256:${createHash("sha256").update(original.buffer).digest("hex")}`,
        sizeBytes: original.size,
      },
      assertInvocation,
    );
  } catch (error) {
    await retainedSource.close();
    throw error;
  }
  let active = true;
  let used = false;
  let pending: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const assertActive = () => {
    if (!active) {
      throw new Error("Accepted attachment admission is closed");
    }
    assertInvocation();
  };
  const close = () => {
    active = false;
    closing ??= (async () => {
      const outcomes = await Promise.allSettled([retainedSource.close(), custody.close()]);
      await pending?.catch(() => {});
      const failures = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      if (failures.length) {
        throw new AggregateError(
          failures.map((outcome) => outcome.reason),
          "Accepted attachment cleanup failed",
        );
      }
    })();
    return closing;
  };
  return Object.freeze({
    originalDigest: custody.digest,
    sizeBytes: custody.sizeBytes,
    getOriginalBytes() {
      assertActive();
      return custody.getBytes();
    },
    async publish(effect: () => void) {
      if (used) {
        throw new AcceptedSessionAttachmentPublicationError(
          "Accepted attachment admission was already consumed",
          "not-entered",
          undefined,
        );
      }
      used = true;
      let effectState: AcceptedSessionAttachmentEffectState = "not-entered";
      let failed = false;
      let failure: unknown;
      try {
        assertActive();
        if (typeof effect !== "function" || types.isAsyncFunction(effect)) {
          throw new Error("Accepted attachment publication effect must be synchronous");
        }
        const publication = custody.withCustody(async (assertOriginalCurrent) => {
          assertActive();
          await publishSessionTranscriptSourceAdmissionEffect(
            retainedSource,
            () => {
              effectState = "entered";
              const result: unknown = effect();
              if (isPromiseLike(result)) {
                void Promise.resolve(result).catch(() => {});
                throw new Error("Accepted attachment publication effect must be synchronous");
              }
              effectState = "completed";
            },
            () => {
              assertActive();
              assertOriginalCurrent();
            },
          );
          if (effectState !== "completed") {
            throw new AcceptedSessionAttachmentPublicationError(
              "Accepted attachment effect did not complete",
              effectState,
              undefined,
            );
          }
        });
        pending = publication;
        await publication;
      } catch (error) {
        failed = true;
        failure = error;
        if (error instanceof AcceptedSessionAttachmentPublicationError) {
          effectState = error.effectState;
        }
      } finally {
        pending = undefined;
        try {
          await close();
        } catch (error) {
          failure = failed ? new AggregateError([failure, error]) : error;
          failed = true;
        }
      }
      if (failed) {
        throw new AcceptedSessionAttachmentPublicationError(
          "Accepted attachment publication failed",
          effectState,
          failure,
        );
      }
    },
    close,
  });
}
