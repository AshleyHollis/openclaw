import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { parseInboundMediaUri } from "../../media/inbound-media-uri.js";
import { readPersistedMediaFacts } from "../../media/media-facts.js";
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
import type { AcceptedSessionAttachmentSelection } from "./session-attachment-admission.types.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  createSessionTranscriptVisibleMessageDigest,
  projectVisibleMessageEntry,
} from "./session-transcript-visible-message.js";

export type AcceptedAttachmentSourceRead = { digest: string; mediaId: string };

function persistedInboundId(source: string, mediaRoot: string): string | undefined {
  const uri = parseInboundMediaUri(source);
  if (uri) {
    return uri.id;
  }
  if (!path.isAbsolute(source)) {
    return undefined;
  }
  const id = path.relative(path.resolve(mediaRoot, "inbound"), path.resolve(source));
  if (!id || id === "." || id === ".." || path.isAbsolute(id) || /[\\/\0]/u.test(id)) {
    return undefined;
  }
  return parseInboundMediaUri(`media://inbound/${encodeURIComponent(id)}`)?.id;
}

/** Reads exactly the selected accepted user entry; never restores or scans a transcript. */
export function bindSqliteWorkerBackend(
  input: {
    scope: ResolvedTranscriptScope;
    selection: AcceptedSessionAttachmentSelection;
    mediaRoot: string;
  },
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
) {
  const database = {
    agentId: input.scope.agentId,
    path: context.databasePath,
    db: context.database,
  };
  return {
    execute(command: { type: "read"; input: undefined }): AcceptedAttachmentSourceRead {
      if (command.type !== "read") {
        throw new Error("Unsupported accepted attachment preparation");
      }
      context.admit("transaction");
      const result = readCurrentProjectionSnapshot(database, input.scope, (projection) => {
        if (
          projection.hasUnindexedPrefix ||
          projection.generation !== input.selection.generation ||
          readSessionEntryRow(database, input.scope.sessionKey)?.entry.sessionId !==
            input.selection.sessionId
        ) {
          throw new Error("Accepted attachment source incarnation or projection changed");
        }
        const identity = readActiveTranscriptEntryIdentityInSnapshot(
          projection,
          input.selection.entryId,
        );
        const fence = resolveSqliteSessionTranscriptReadFence({ database, ...input.scope });
        if (!identity || (fence && identity.seq >= fence.beforeRawSeq)) {
          throw new Error("Accepted attachment entry is no longer visible");
        }
        const query = selectMessageRows(database, input.scope.sessionId, {
          start: 0,
          endExclusive: Number.MAX_SAFE_INTEGER,
        })
          .where("active.event_seq", "=", identity.seq)
          .limit(1);
        const metadata = executeSqliteQueryTakeFirstSync(database.db, selectMessageMetadata(query));
        if (!metadata || metadata.serialized_bytes > MAX_VISIBLE_MESSAGE_MAX_BYTES) {
          throw new Error("Accepted attachment message exceeds admission bounds");
        }
        const visible = resolveVisibleMessagePositions(projection);
        if (
          metadata.message_position < visible.postStart &&
          !visible.kept.includes(metadata.message_position)
        ) {
          throw new Error("Accepted attachment entry is outside its visible reset window");
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
        if (!entry || entry.entryId !== input.selection.entryId || entry.role !== "user") {
          throw new Error("Accepted attachment requires an exact accepted user message");
        }
        const message = asOptionalRecord(entry.message);
        const visibility = asOptionalRecord(asOptionalRecord(message?.["__openclaw"])?.visibility);
        if (message?.display === false || visibility?.display === false) {
          throw new Error("Accepted attachment user message is hidden from its selected surface");
        }
        const fact = readPersistedMediaFacts(entry.message)?.[input.selection.mediaIndex];
        if (!fact || (!fact.path && !fact.url)) {
          throw new Error("Accepted attachment index is unavailable");
        }
        const refs = [fact.path, fact.url].filter(
          (value): value is string => typeof value === "string",
        );
        const ids = refs.map((ref) => persistedInboundId(ref, input.mediaRoot));
        const selected = parseInboundMediaUri(input.selection.mediaRef);
        if (!selected || !ids.length || ids.some((id) => id !== selected.id)) {
          throw new Error(
            "Accepted attachment reference differs from its exact persisted inbound fact",
          );
        }
        return { digest: createSessionTranscriptVisibleMessageDigest(entry), mediaId: selected.id };
      });
      if (result.kind !== "value") {
        throw new Error("Accepted attachment projection is unavailable");
      }
      context.admit("commit");
      return result.value;
    },
    assertSettled() {
      if (context.database.isTransaction) {
        throw new Error("Accepted attachment preparation did not settle");
      }
    },
    close() {},
  };
}
