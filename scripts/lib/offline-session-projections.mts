import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  SYNC_REBUILD_MAX_BYTES,
  SYNC_REBUILD_MAX_ROWS,
} from "../../src/config/sessions/session-transcript-index.js";
import {
  extractTranscriptIndexEntry,
  hasTranscriptMessage,
  transcriptEventContextEligibility,
  visitSessionTranscriptProjection,
} from "../../src/config/sessions/session-transcript-projection-rebuild.js";
import { rowsDigest, tableRows } from "./offline-session-rows.mts";

type Row = Record<string, SQLOutputValue>;
type ProjectionDisposition = {
  bytes: bigint;
  count: bigint;
  dirty: boolean;
  outcome: "unchanged" | "dirty" | "rebuilt";
};

function refuse(): never {
  throw new Error("Offline original history accounting rejected transcript projection changes.");
}

function preservesProjection(beforeJson: string, afterJson: string): boolean {
  const before: unknown = JSON.parse(beforeJson);
  const after: unknown = JSON.parse(afterJson);
  if (!isRecord(before) || !isRecord(after)) {
    return false;
  }
  const { message: _beforeMessage, ...beforeEnvelope } = before;
  const { message: _afterMessage, ...afterEnvelope } = after;
  return (
    isDeepStrictEqual(beforeEnvelope, afterEnvelope) &&
    hasTranscriptMessage(before) === hasTranscriptMessage(after) &&
    transcriptEventContextEligibility(before) === transcriptEventContextEligibility(after) &&
    isDeepStrictEqual(extractTranscriptIndexEntry(before, 0), extractTranscriptIndexEntry(after, 0))
  );
}

/** Account native media rewrite batches without executing a second migration. */
function projectionDispositions(
  database: DatabaseSync,
  states: Row[],
  active: Row[],
  convert: (raw: string) => string,
) {
  const stateBySession = new Map(states.map((row) => [row.session_id, row]));
  const unclassified = new Set(
    active.filter((row) => row.context_eligible === null).map((row) => row.session_id),
  );
  const sizes = database.prepare(`SELECT session_id, count(*) AS event_count,
    sum(octet_length(event_json)) AS event_bytes, max(seq) AS latest_seq
    FROM transcript_events GROUP BY session_id`);
  sizes.setReadBigInts(true);
  const dispositions = new Map<string, ProjectionDisposition>();
  for (const row of sizes.iterate()) {
    if (
      typeof row.session_id !== "string" ||
      typeof row.event_count !== "bigint" ||
      typeof row.event_bytes !== "bigint"
    ) {
      refuse();
    }
    const state = stateBySession.get(row.session_id);
    dispositions.set(row.session_id, {
      bytes: row.event_bytes,
      count: row.event_count,
      dirty:
        !state ||
        state.needs_rebuild !== 0n ||
        state.indexed_seq !== row.latest_seq ||
        unclassified.has(row.session_id),
      outcome: "unchanged",
    });
  }
  const batchDeltas = new Map<string, bigint>();
  const finishBatch = () => {
    for (const [sessionId, delta] of batchDeltas) {
      const state = dispositions.get(sessionId);
      if (!state) {
        refuse();
      }
      // Native eligibility uses stored size BEFORE this batch's writes.
      if (state.dirty) {
        if (
          state.count <= BigInt(SYNC_REBUILD_MAX_ROWS) &&
          state.bytes <= BigInt(SYNC_REBUILD_MAX_BYTES)
        ) {
          state.outcome = "rebuilt";
          state.dirty = false;
        } else {
          state.outcome = "dirty";
        }
      }
      state.bytes += delta;
    }
    batchDeltas.clear();
  };
  // Pinned media-persistence owner batches ALL rows globally, not only changed rows.
  let batchRows = 0;
  const events = database.prepare(
    "SELECT session_id,event_json FROM transcript_events ORDER BY session_id,seq",
  );
  for (const row of events.iterate()) {
    if (typeof row.session_id !== "string" || typeof row.event_json !== "string") {
      refuse();
    }
    const after = convert(row.event_json);
    if (after !== row.event_json) {
      if (!preservesProjection(row.event_json, after)) {
        refuse();
      }
      batchDeltas.set(
        row.session_id,
        (batchDeltas.get(row.session_id) ?? 0n) +
          BigInt(Buffer.byteLength(after, "utf8") - Buffer.byteLength(row.event_json, "utf8")),
      );
    }
    batchRows += 1;
    if (batchRows === 64) {
      finishBatch();
      batchRows = 0;
    }
  }
  finishBatch();
  return dispositions;
}

/** Verify index state, active navigation and logical FTS rows after canonical event verification. */
export function captureOfflineSessionProjections(
  database: DatabaseSync,
  convert: (raw: string) => string,
) {
  const states = tableRows(database, "session_transcript_index_state");
  const active = tableRows(database, "session_transcript_active_events");
  for (const row of active) {
    row.context_eligible ??= null;
  }
  const fts = tableRows(database, "session_transcript_fts");
  const dispositions = projectionDispositions(database, states, active, convert);
  const startedAt = BigInt(Date.now());
  return (prepared: DatabaseSync): void => {
    const finishedAt = BigInt(Date.now());
    const earliest = startedAt < finishedAt ? startedAt : finishedAt;
    const latest = startedAt > finishedAt ? startedAt : finishedAt;
    const rebuilt = new Set(
      [...dispositions].filter(([, state]) => state.outcome === "rebuilt").map(([id]) => id),
    );
    const changed = new Set(
      [...dispositions].filter(([, state]) => state.outcome !== "unchanged").map(([id]) => id),
    );
    const expectedStates = states.filter(
      (row) => typeof row.session_id !== "string" || !changed.has(row.session_id),
    );
    const expectedActive = active.filter(
      (row) => typeof row.session_id !== "string" || !rebuilt.has(row.session_id),
    );
    const expectedFts = fts.filter(
      (row) => typeof row.session_id !== "string" || !rebuilt.has(row.session_id),
    );
    const currentStates = tableRows(prepared, "session_transcript_index_state");
    const currentBySession = new Map(currentStates.map((row) => [row.session_id, row]));
    const originalBySession = new Map(states.map((row) => [row.session_id, row]));
    const timestampBinding = prepared.prepare("SELECT ? AS value");
    timestampBinding.setReadBigInts(true);
    for (const sessionId of changed) {
      const current = currentBySession.get(sessionId);
      if (
        !current ||
        typeof current.updated_at !== "bigint" ||
        current.updated_at < earliest ||
        current.updated_at > latest
      ) {
        refuse();
      }
      const expected: Row = {
        ...(originalBySession.get(sessionId) ?? {
          session_id: sessionId,
          indexed_seq: -1n,
          leaf_event_id: null,
          active_event_count: 0n,
          active_message_count: 0n,
        }),
        needs_rebuild: 1n,
        updated_at: current.updated_at,
      };
      if (rebuilt.has(sessionId)) {
        const projection = visitSessionTranscriptProjection(prepared, sessionId, {
          activeRow: (row) =>
            expectedActive.push({
              session_id: sessionId,
              active_position: BigInt(row.activePosition),
              event_seq: BigInt(row.eventSeq),
              message_position: row.messagePosition === null ? null : BigInt(row.messagePosition),
              context_eligible: BigInt(row.contextEligible),
            }),
          ftsRow: (row) =>
            expectedFts.push({
              session_id: sessionId,
              message_id: row.messageId,
              role: row.role,
              text: row.text,
              timestamp: timestampBinding.get(row.timestamp)!.value!,
            }),
        });
        if (!projection) {
          refuse();
        }
        expected.active_event_count = BigInt(projection.activeEventCount);
        expected.active_message_count = BigInt(projection.activeMessageCount);
        expected.indexed_seq = BigInt(projection.sourceIndexedSeq);
        expected.leaf_event_id = projection.leafEventId;
        expected.needs_rebuild = 0n;
      }
      expectedStates.push(expected);
    }
    if (
      rowsDigest(currentStates) !== rowsDigest(expectedStates) ||
      rowsDigest(tableRows(prepared, "session_transcript_active_events")) !==
        rowsDigest(expectedActive) ||
      rowsDigest(tableRows(prepared, "session_transcript_fts")) !== rowsDigest(expectedFts)
    ) {
      refuse();
    }
  };
}
