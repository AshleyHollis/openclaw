import { types } from "node:util";
import { isMainThread } from "node:worker_threads";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  assertExistingDatabaseIdentity,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readActiveTranscriptEntryIdentityInSnapshot } from "./session-accessor.sqlite-active-events.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  parseActiveTranscriptMessageRow,
  readCurrentProjectionSnapshot,
  selectMessageMetadata,
  selectMessagePayload,
  selectMessageRows,
} from "./session-accessor.sqlite-projection-read.js";
import { resolveVisibleMessagePositions } from "./session-accessor.sqlite-reset-window.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { MAX_VISIBLE_MESSAGE_MAX_BYTES } from "./session-accessor.sqlite-visible-cursor.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  createSessionTranscriptVisibleMessageDigest,
  projectVisibleMessageEntry,
  type SessionTranscriptMessageEntry,
} from "./session-transcript-visible-message.js";

/** Private worker attachment prepared by the transcript owner, never source authority by itself. */
export type SessionTranscriptSourceLockFacts = Readonly<{
  scope: ResolvedTranscriptScope;
  identity: DatabasePathIdentity;
  entryId: string;
  generation: string;
  digest: string;
}>;

/** Source first, destination second: the native writer lock spans the synchronous destination effect. */
export function withSessionTranscriptSourceLock<T>(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  facts: SessionTranscriptSourceLockFacts,
  assertCurrent: () => void,
  effect: (entry: SessionTranscriptMessageEntry) => T,
): T {
  if (isMainThread) {
    throw new Error("Transcript source admission requires a native worker");
  }
  if (database.db.isTransaction) {
    throw new Error("Transcript source admission cannot join an existing transaction");
  }
  if (types.isAsyncFunction(effect)) {
    throw new Error("Transcript source admission effect must be synchronous");
  }
  const assertOwner = () => {
    assertCurrent();
    const opened = readOpenClawAgentDatabaseIdentity(database);
    if (
      database.agentId !== facts.scope.agentId ||
      database.path !== facts.identity.canonicalPath ||
      typeof opened.identity !== "string" ||
      `file:${opened.identity}` !== facts.identity.key ||
      opened.birthtime !== facts.identity.birthtime
    ) {
      throw new Error("Transcript source database differs from its prepared owner");
    }
    assertExistingDatabaseIdentity(database.path, facts.identity.key, facts.identity.birthtime);
  };
  assertOwner();
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      assertOwner();
      const result = readCurrentProjectionSnapshot(database, facts.scope, (projection) => {
        // Legacy unindexed controls require history traversal, which admission cannot perform.
        if (projection.hasUnindexedPrefix) {
          throw new Error("Transcript source projection requires reconciliation");
        }
        const session = readSessionEntryRow(database, facts.scope.sessionKey)?.entry;
        if (
          session?.sessionId !== facts.scope.sessionId ||
          projection.generation !== facts.generation
        ) {
          throw new Error("Transcript source incarnation or generation changed");
        }
        const identity = readActiveTranscriptEntryIdentityInSnapshot(projection, facts.entryId);
        const fence = resolveSqliteSessionTranscriptReadFence({ database, ...facts.scope });
        if (!identity || (fence && identity.seq >= fence.beforeRawSeq)) {
          throw new Error("Transcript source entry is no longer visible");
        }
        const query = selectMessageRows(database, facts.scope.sessionId, {
          start: 0,
          endExclusive: Number.MAX_SAFE_INTEGER,
        })
          .where("active.event_seq", "=", identity.seq)
          .limit(1);
        const metadata = executeSqliteQueryTakeFirstSync(database.db, selectMessageMetadata(query));
        if (!metadata || metadata.serialized_bytes > MAX_VISIBLE_MESSAGE_MAX_BYTES) {
          throw new Error("Transcript source message exceeds admission bounds");
        }
        const visible = resolveVisibleMessagePositions(projection);
        if (
          metadata.message_position < visible.postStart &&
          !visible.kept.includes(metadata.message_position)
        ) {
          throw new Error("Transcript source entry is outside its visible reset window");
        }
        const row = executeSqliteQueryTakeFirstSync(
          database.db,
          selectMessagePayload(database, query),
        );
        const entry = row
          ? projectVisibleMessageEntry({
              ...parseActiveTranscriptMessageRow(row),
              parentId: identity.parentId,
            })[0]
          : undefined;
        if (
          !entry ||
          entry.entryId !== facts.entryId ||
          createSessionTranscriptVisibleMessageDigest(entry) !== facts.digest
        ) {
          throw new Error("Transcript source message changed");
        }
        assertOwner();
        const value = effect(entry);
        if (isPromiseLike(value)) {
          void Promise.resolve(value).catch(() => {});
          throw new Error("Transcript source admission effect must be synchronous");
        }
        return value;
      });
      if (result.kind !== "value") {
        throw new Error("Transcript source projection is unavailable");
      }
      return result.value;
    },
    { databaseLabel: database.path, operationLabel: "session.transcript.source-admission" },
  );
}
