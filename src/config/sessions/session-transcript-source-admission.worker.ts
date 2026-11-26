import type { DatabaseSync } from "node:sqlite";
import {
  withSessionTranscriptSourceLock,
  type SessionTranscriptSourceLockFacts,
} from "./session-accessor.sqlite-source-lock.js";

/** Borrows the existing canonical agent executor; this module never opens or closes it. */
export function bindSqliteWorkerBackend(
  input: { sourceFacts: SessionTranscriptSourceLockFacts },
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
) {
  return {
    execute(command: { type: "validate"; input: undefined }) {
      if (command.type !== "validate") {
        throw new Error("Unsupported transcript source preparation command");
      }
      return withSessionTranscriptSourceLock(
        {
          agentId: input.sourceFacts.scope.agentId,
          path: context.databasePath,
          db: context.database,
        },
        input.sourceFacts,
        () => {},
        () => {
          context.admit("transaction");
          context.admit("commit");
        },
      );
    },
    assertSettled() {
      if (context.database.isTransaction) {
        throw new Error("Transcript source preparation did not settle");
      }
    },
    close() {},
  };
}
