import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  withSessionTranscriptSourceLock,
  type SessionTranscriptSourceLockFacts,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import type { SqliteWorkerCommand } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type {
  WorkboardSqliteOperations,
  WorkboardSqliteWorkerOperations,
} from "./sqlite-store-contract.js";
import { encodeWorkboardSqliteFailure } from "./sqlite-store-errors.js";
import { createWorkboardSqliteKernel, type WorkboardSqliteKernel } from "./sqlite-store-kernel.js";

type SourceInput = {
  sourceFacts: SessionTranscriptSourceLockFacts;
  databasePath: string;
  destinationIdentity: { dev: string; ino: string; birthtime: string };
};

/** The source domain supplies its already-admitted connection; this backend never opens it. */
export function bindSqliteWorkerBackend(
  input: SourceInput,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
) {
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
    execute(command: SqliteWorkerCommand<WorkboardSqliteOperations>) {
      try {
        if (!active) {
          throw new Error("Workboard source publication has settled.");
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
              // Source validation precedes even destination metadata admission.
              kernel ??= createWorkboardSqliteKernel(input.databasePath, undefined, (stage) => {
                assertDestination();
                context.admit(stage);
              });
              const current = kernel;
              switch (command.type) {
                case "cards.register":
                  return current.cards.register(...command.input.args);
                case "cards.registerIfAbsent":
                  return current.cards.registerIfAbsent(...command.input.args);
                case "cards.registerIdempotent":
                  return current.cards.registerIdempotent(...command.input.args);
                default:
                  throw new Error("Workboard source publication only accepts card creation.");
              }
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
  } satisfies {
    execute(
      command: SqliteWorkerCommand<WorkboardSqliteOperations>,
    ): WorkboardSqliteWorkerOperations[keyof WorkboardSqliteWorkerOperations]["output"];
    assertSettled(): void;
    close(): void;
  };
}
