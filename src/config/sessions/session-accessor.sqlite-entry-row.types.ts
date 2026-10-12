import type { Selectable } from "kysely";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { SqliteSessionOwnerRow } from "./session-accessor.sqlite-owner-projection.js";
import type { SessionEntrySnapshotRow } from "./session-entry-snapshots.js";

export type SessionEntryRow = Selectable<OpenClawAgentKyselyDatabase["session_nodes"]> &
  SessionEntrySnapshotRow;

export type PersistedSessionEntryRow = Pick<
  SessionEntryRow,
  "current_session_id" | "entry_json" | "session_key" | "updated_at"
> &
  SqliteSessionOwnerRow &
  SessionEntrySnapshotRow & { rowid?: string } & Partial<
    Pick<SessionEntryRow, "legacy_acp_migration_json">
  >;
