import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { DeleteSessionEntryLifecycleParams } from "./session-accessor.sqlite-contract.js";
import {
  readSessionStateDeleteSnapshot,
  readSessionGenerationIdsForKeys,
} from "./session-accessor.sqlite-delete-snapshot.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export function hasOnlyEmptyCurrentGeneration(
  database: Pick<OpenClawAgentDatabase, "db">,
  entry: SessionEntry,
  target: DeleteSessionEntryLifecycleParams["target"],
): boolean {
  const sessionId = entry.sessionId;
  if (!sessionId || collectSessionStateIdsForEntry(entry).some((id) => id !== sessionId)) {
    return false;
  }
  const keys = [target.canonicalKey, ...target.storeKeys];
  // A rotated generation or retained archive is evidence of prior use even if
  // the current generation has no visible messages.
  if (readSessionGenerationIdsForKeys(database, keys).some((id) => id !== sessionId)) {
    return false;
  }
  const db = getSessionKysely(database.db);
  const archived = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_transcript_archives")
      .select("session_id")
      .where("session_key", "in", keys)
      .limit(1),
  ).rows;
  if (archived.length > 0 || readSessionColdTranscript(database.db, sessionId)) {
    return false;
  }
  const snapshot = readSessionStateDeleteSnapshot(database.db, sessionId);
  return (
    (snapshot.sessionKey === null || keys.includes(snapshot.sessionKey)) &&
    snapshot.generation === null &&
    snapshot.lastSeq === null &&
    snapshot.transcriptUpdatedAt === null &&
    snapshot.trajectoryLastSeq === null &&
    snapshot.acpParentStreamEventCount === 0
  );
}
