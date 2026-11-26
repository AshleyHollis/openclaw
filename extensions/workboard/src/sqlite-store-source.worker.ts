import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  withSessionTranscriptSourceLock,
  type SessionTranscriptSourceLockFacts,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import type {
  SqliteWorkerBackend,
  SqliteWorkerCommand,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { WorkboardSourceWorkerOperations } from "./sqlite-store-contract.js";
import { encodeWorkboardSqliteFailure } from "./sqlite-store-errors.js";
import { createWorkboardSqliteKernel, type WorkboardSqliteKernel } from "./sqlite-store-kernel.js";

type SourceInput = {
  sourceFacts: SessionTranscriptSourceLockFacts;
  databasePath: string;
  destinationIdentity: { dev: string; ino: string; birthtime: string };
};

/** Use the exact admitted agent database, then the exact Workboard SQLite destination. */
export function bindSqliteWorkerBackend(
  input: SourceInput,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<WorkboardSourceWorkerOperations> {
  let kernel: WorkboardSqliteKernel | undefined;
  let active = true;
  const assertDestination = () => {
    if (!active) {
      throw new Error("Workboard source publication has settled.");
    }
    const file = statSync(input.databasePath, { bigint: true });
    if (
      !file.isFile() ||
      file.dev.toString() !== input.destinationIdentity.dev ||
      file.ino.toString() !== input.destinationIdentity.ino ||
      file.birthtimeNs.toString() !== input.destinationIdentity.birthtime
    ) {
      throw new Error("Workboard source destination changed before publication.");
    }
    if (`file:${file.dev}:${file.ino}` === input.sourceFacts.identity.key) {
      throw new Error("Workboard destination cannot be its transcript source database.");
    }
  };
  assertDestination();
  return {
    execute(command: SqliteWorkerCommand<WorkboardSourceWorkerOperations>) {
      try {
        if (command.type !== "create") {
          throw new Error("Workboard source publication only accepts card creation.");
        }
        return {
          ok: true as const,
          value: withSessionTranscriptSourceLock(
            {
              agentId: input.sourceFacts.scope.agentId,
              db: context.database,
              path: context.databasePath,
            },
            input.sourceFacts,
            assertDestination,
            () => {
              const destination = (kernel ??= createWorkboardSqliteKernel(input.databasePath));
              assertDestination();
              return destination.withWriteTransaction(
                () => {
                  context.admit("transaction");
                  return destination.registerSource(command.input);
                },
                {
                  withCommit(commit) {
                    assertDestination();
                    context.admit("commit");
                    assertDestination();
                    commit();
                  },
                },
              );
            },
          ),
        };
      } catch (error) {
        return { ok: false as const, failure: encodeWorkboardSqliteFailure(error) };
      }
    },
    assertSettled() {
      if (context.database.isTransaction) {
        throw new Error("Workboard source publication retained its source transaction.");
      }
    },
    close() {
      active = false;
      kernel?.close();
      kernel = undefined;
    },
  };
}
