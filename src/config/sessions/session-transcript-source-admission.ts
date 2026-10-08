import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { SqliteWorkerOperations } from "../../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-contract.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptSourceLockFacts } from "./session-accessor.sqlite-source-lock.js";
import { bindSessionTranscriptStoreScope } from "./session-accessor.transcript-target.js";
import {
  AcceptedSessionAttachmentPublicationError,
  type AcceptedSessionAttachmentEffectState,
} from "./session-attachment-admission.types.js";

/** Exact public source identity. Paths and native authority are deliberately absent. */
export type SessionTranscriptSourceSelection = Readonly<{
  agentId: string;
  sessionKey: string;
  sessionId: string;
  entryId: string;
  generation: string;
  digest: string;
}>;

/** Captured host authority, supplied outside tool/HTTP JSON and kept live through native commit. */
export type SessionTranscriptSourceAuthority = Readonly<{
  assertCurrent(selection: SessionTranscriptSourceSelection): void;
  signal?: AbortSignal;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}>;

declare const sourceAdmissionBrand: unique symbol;
export type PreparedSessionTranscriptSourceAdmission = Readonly<{
  [sourceAdmissionBrand]: true;
  close(): Promise<void>;
}>;

type PreparedSource = {
  active: boolean;
  used: boolean;
  assertCurrent(): void;
  facts: SessionTranscriptSourceLockFacts;
  owner: Awaited<ReturnType<typeof loadSessionEntryForAdmission>>;
  pending: Set<Promise<unknown>>;
  close(): Promise<void>;
};

// A serialized descriptor cannot manufacture a captured execution or a retained admission.
const preparedSources = new WeakMap<PreparedSessionTranscriptSourceAdmission, PreparedSource>();

/** Prepare one bounded source against the real native owner without restoring or rebuilding history. */
export async function prepareSessionTranscriptSourceAdmission(
  input: SessionTranscriptSourceSelection,
  capturedNativeAuthority: SessionTranscriptSourceAuthority,
): Promise<PreparedSessionTranscriptSourceAdmission> {
  if (
    typeof capturedNativeAuthority?.assertCurrent !== "function" ||
    types.isAsyncFunction(capturedNativeAuthority.assertCurrent)
  ) {
    throw new Error("Transcript source preparation requires captured native authority");
  }
  const selection = Object.freeze({
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    entryId: input.entryId,
    generation: input.generation,
    digest: input.digest,
  });
  const assertNativeCurrent = capturedNativeAuthority.assertCurrent.bind(capturedNativeAuthority);
  const signal = capturedNativeAuthority.signal;
  const env = capturedNativeAuthority.env ? { ...capturedNativeAuthority.env } : undefined;
  for (const value of [
    selection.agentId,
    selection.sessionKey,
    selection.sessionId,
    selection.entryId,
    selection.generation,
  ]) {
    if (typeof value !== "string" || !value.trim() || value.length > 4096) {
      throw new Error("Transcript source identity is invalid");
    }
  }
  if (!/^sha256-public-message-v1:[a-f0-9]{64}$/.test(selection.digest)) {
    throw new Error("Transcript source digest is invalid or unsupported");
  }
  if (isIncognitoSessionKey(selection.sessionKey)) {
    throw new Error("Incognito transcripts cannot be re-persisted");
  }
  const agentId = normalizeAgentId(selection.agentId);
  if (parseAgentSessionKey(selection.sessionKey)?.agentId !== agentId) {
    throw new Error("Transcript source Session does not belong to its exact agent");
  }
  const assertInvocation = () => {
    signal?.throwIfAborted();
    const result: unknown = assertNativeCurrent(selection);
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new Error("Transcript source native authority must be synchronous");
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
  let transferred = false;
  try {
    assertInvocation();
    if (
      !owner.execution ||
      !owner.databaseOptions ||
      owner.entry?.sessionId !== selection.sessionId
    ) {
      throw new Error("Transcript source Session is unavailable or replaced");
    }
    const identity = readDatabasePathIdentitySync(owner.execution.path);
    const nativeIdentity = owner.execution.fileIdentity;
    if (
      !nativeIdentity ||
      identity.key !== `file:${nativeIdentity.physicalIdentity}` ||
      identity.birthtime !== nativeIdentity.birthtime
    ) {
      throw new Error("Transcript source database changed during preparation");
    }
    const facts: SessionTranscriptSourceLockFacts = Object.freeze({
      scope: { ...resolveSqliteTranscriptScope(scope), path: identity.canonicalPath },
      identity,
      entryId: selection.entryId,
      generation: selection.generation,
      digest: selection.digest,
    });
    let closing: Promise<void> | undefined;
    const source: PreparedSource = {
      active: true,
      used: false,
      facts,
      owner,
      pending: new Set(),
      assertCurrent() {
        if (!source.active) {
          throw new Error("Transcript source admission is closed");
        }
        assertInvocation();
        owner.databaseClaim.assertCurrent();
        owner.execution?.assertCurrent();
      },
      close() {
        source.active = false;
        closing ??= (async () => {
          await Promise.allSettled(source.pending);
          await owner.databaseClaim.release();
        })();
        return closing;
      },
    };
    // This first validation uses the same source-bound native owner as publication.
    // It is preparation evidence only; the publication rechecks under its writer lock.
    const validation = await openOpenClawAgentSqliteWorkerStore<{
      validate: { input: undefined; output: void };
    }>(
      owner.databaseOptions,
      { execution: owner.execution },
      {
        moduleUrl: resolveRuntimeWorkerUrl(
          runtimeProcessEntrypoints.sessionTranscriptSourceAdmission,
        ),
        input: { sourceFacts: facts },
      },
    );
    try {
      await validation.execute(
        { type: "validate", input: undefined },
        () => source.assertCurrent(),
        {
          signal,
        },
      );
    } finally {
      await validation.close();
    }
    source.assertCurrent();
    // Only this owner mints capabilities. close revokes retained callers before awaiting native release.
    const capability = Object.freeze({
      close: () => source.close(),
    }) as PreparedSessionTranscriptSourceAdmission; // SAFETY: WeakMap brands this owner-issued object.
    preparedSources.set(capability, source);
    transferred = true;
    return capability;
  } finally {
    if (!transferred) {
      await owner.databaseClaim.release();
    }
  }
}

/** Bind a trusted static native publisher to this exact retained source; the worker owns both commits. */
export async function runSessionTranscriptSourceAdmissionOperation<
  Operations extends SqliteWorkerOperations,
  Key extends keyof Operations = keyof Operations,
>(
  capability: PreparedSessionTranscriptSourceAdmission,
  worker: { moduleUrl: URL; input: Readonly<Record<string, unknown>> },
  command: { type: Key; input: Operations[Key]["input"] },
  assertCurrent: () => void,
): Promise<Operations[Key]["output"]> {
  const source = preparedSources.get(capability);
  if (!source || source.used) {
    throw new Error("Transcript source admission is absent or already consumed");
  }
  source.used = true;
  const owner = source.owner;
  const assert = () => {
    source.assertCurrent();
    assertCurrent();
    source.assertCurrent();
  };
  const operation = (async () => {
    assert();
    if (!owner.databaseOptions || !owner.execution) {
      throw new Error("Transcript source lost its captured native execution");
    }
    const store = await openOpenClawAgentSqliteWorkerStore<Operations>(
      owner.databaseOptions,
      { execution: owner.execution },
      { ...worker, input: { ...worker.input, sourceFacts: source.facts } },
    );
    try {
      assert();
      return await store.execute(command, assert);
    } finally {
      await store.close();
    }
  })();
  source.pending.add(operation);
  try {
    return await operation;
  } finally {
    source.pending.delete(operation);
    await source.close();
  }
}

/** Private attachment owner composition. Never serialize or expose the captured host effect. */
export async function publishSessionTranscriptSourceAdmissionEffect(
  capability: PreparedSessionTranscriptSourceAdmission,
  effect: () => void,
  assertOriginalCurrent: () => void,
): Promise<void> {
  const source = preparedSources.get(capability);
  if (!source || source.used) {
    throw new AcceptedSessionAttachmentPublicationError(
      "Transcript source admission is absent or already consumed",
      "not-entered",
      undefined,
    );
  }
  source.used = true;
  let effectState: AcceptedSessionAttachmentEffectState = "not-entered";
  const assert = () => {
    source.assertCurrent();
    assertOriginalCurrent();
    source.assertCurrent();
  };
  const operation = (async () => {
    if (typeof effect !== "function" || types.isAsyncFunction(effect)) {
      throw new Error("Accepted attachment publication effect must be synchronous");
    }
    assert();
    const { databaseOptions, execution } = source.owner;
    if (!databaseOptions || !execution) {
      throw new Error("Transcript source lost its captured native execution");
    }
    const authority: AgentDatabaseRequestExecutionSource = {
      assertCurrent: assert,
      createAdmission(binding) {
        return () => {
          let phase: "waiting" | "transaction" | "commit" = "waiting";
          return {
            nativeLocations: binding.nativeLocations,
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              binding.authorize(request);
              if (request.stage === "transaction") {
                if (phase !== "waiting") {
                  throw new Error("Attachment source transaction requested out of order");
                }
                phase = "transaction";
              } else if (request.stage === "commit") {
                if (phase !== "transaction" || effectState !== "not-entered") {
                  throw new Error("Attachment source publication requested out of order");
                }
                phase = "commit";
                assert();
                effectState = "entered";
                const result: unknown = effect();
                if (isPromiseLike(result)) {
                  void Promise.resolve(result).catch(() => {});
                  throw new Error("Accepted attachment publication effect must be synchronous");
                }
                effectState = "completed";
              }
              if (!grant()) {
                throw new Error("Attachment source publication authority expired");
              }
            }, binding.attachment),
          };
        };
      },
    };
    await runOpenClawAgentWorkerWrite(databaseOptions, async () => {
      const receipt = await execution.runExisting(authority, async (scope) => {
        await scope.execute({
          type: "database.domain.publish",
          input: {
            id: randomUUID(),
            moduleUrl: resolveRuntimeWorkerUrl(
              runtimeProcessEntrypoints.sessionTranscriptSourceAdmission,
            ).href,
            input: { sourceFacts: source.facts },
            command: { type: "validate", input: undefined },
          },
        });
        return true;
      });
      if (!receipt || effectState !== "completed") {
        throw new Error("Attachment source publication did not complete");
      }
    });
  })();
  source.pending.add(operation);
  let failed = false;
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    source.pending.delete(operation);
    try {
      await source.close();
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
}
