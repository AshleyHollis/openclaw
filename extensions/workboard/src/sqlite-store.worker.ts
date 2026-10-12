import type {
  SqliteWorkerBackend,
  SqliteWorkerCommand,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { requestSqliteWorkerOperationAdmission } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type {
  WorkboardSqliteOperations,
  WorkboardSqliteWorkerOperations,
} from "./sqlite-store-contract.js";
import { encodeWorkboardSqliteFailure } from "./sqlite-store-errors.js";
import { createWorkboardSqliteKernel, type WorkboardSqliteKernel } from "./sqlite-store-kernel.js";
type Connection = { kernel?: WorkboardSqliteKernel; close: () => void };
type ConnectionCommand = Exclude<
  SqliteWorkerCommand<WorkboardSqliteOperations>,
  { type: "connection.open" }
>;

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<WorkboardSqliteWorkerOperations> {
  let guarded = false;
  const admitWrite = (stage: "transaction" | "commit") => {
    if (guarded) {
      requestSqliteWorkerOperationAdmission({ stage, facts: undefined });
    }
  };
  const initial = createWorkboardSqliteKernel(context.databasePath, undefined, admitWrite);
  const connections = new Map<number, Connection>();
  // Broker admission opens the native database; the first logical lease adopts it.
  connections.set(0, { kernel: initial, close: initial.close });
  let nextConnection = 0;
  function execute(
    command: ConnectionCommand,
  ): WorkboardSqliteWorkerOperations[keyof WorkboardSqliteWorkerOperations]["output"] {
    const connection = connections.get(command.input.connection);
    if (!connection) {
      throw new Error("Workboard SQLite connection is closed.");
    }
    if (command.type === "connection.close") {
      connection.close();
      connections.delete(command.input.connection);
      return { ok: true, value: undefined };
    }
    const kernel = connection.kernel;
    if (!kernel) {
      throw new Error("Workboard SQLite connection initialization failed.");
    }
    switch (command.type) {
      case "dataVersion":
        return { ok: true, value: kernel.dataVersion() };
      case "cards.registerWithResultReview":
        return { ok: true, value: kernel.cards.registerWithResultReview(...command.input.args) };
      case "cards.getResultReview":
        return { ok: true, value: kernel.cards.getResultReview(...command.input.args) };
      case "cards.listResultReviews":
        return { ok: true, value: kernel.cards.listResultReviews(...command.input.args) };
      case "cards.resolveResultReview":
        return { ok: true, value: kernel.cards.resolveResultReview(...command.input.args) };
      case "cards.register":
        return { ok: true, value: kernel.cards.register(...command.input.args) };
      case "cards.registerIfAbsent":
        return { ok: true, value: kernel.cards.registerIfAbsent(...command.input.args) };
      case "cards.registerIdempotent":
        return { ok: true, value: kernel.cards.registerIdempotent(...command.input.args) };
      case "cards.registerIfUpdatedAt":
        return { ok: true, value: kernel.cards.registerIfUpdatedAt(...command.input.args) };
      case "cards.claimIfOwnerAvailable":
        return { ok: true, value: kernel.cards.claimIfOwnerAvailable(...command.input.args) };
      case "cards.deleteIfUpdatedAt":
        return { ok: true, value: kernel.cards.deleteIfUpdatedAt(...command.input.args) };
      case "cards.lookup":
        return { ok: true, value: kernel.cards.lookup(...command.input.args) };
      case "cards.delete":
        return { ok: true, value: kernel.cards.delete(...command.input.args) };
      case "cards.entries":
        return { ok: true, value: kernel.cards.entries(...command.input.args) };
      case "cards.listCardStatuses":
        return { ok: true, value: kernel.cards.listCardStatuses(...command.input.args) };
      case "cards.listBoardAggregates":
        return { ok: true, value: kernel.cards.listBoardAggregates(...command.input.args) };
      case "cards.listStatsAggregates":
        return { ok: true, value: kernel.cards.listStatsAggregates(...command.input.args) };
      case "cards.hasCards":
        return { ok: true, value: kernel.cards.hasCards(...command.input.args) };
      case "boards.register":
        return { ok: true, value: kernel.boards.register(...command.input.args) };
      case "boards.lookup":
        return { ok: true, value: kernel.boards.lookup(...command.input.args) };
      case "boards.delete":
        return { ok: true, value: kernel.boards.delete(...command.input.args) };
      case "boards.entries":
        return { ok: true, value: kernel.boards.entries(...command.input.args) };
      case "sessionsBoard.get":
        return { ok: true, value: kernel.sessionsBoard.get(...command.input.args) };
      case "sessionsBoard.update":
        return { ok: true, value: kernel.sessionsBoard.update(...command.input.args) };
      case "sessionsBoard.listPlacements":
        return { ok: true, value: kernel.sessionsBoard.listPlacements(...command.input.args) };
      case "sessionsBoard.repairPlacements":
        return { ok: true, value: kernel.sessionsBoard.repairPlacements(...command.input.args) };
      case "sessionsBoard.writePlacement":
        return { ok: true, value: kernel.sessionsBoard.writePlacement(...command.input.args) };
      case "subscriptions.register":
        return { ok: true, value: kernel.subscriptions.register(...command.input.args) };
      case "subscriptions.lookup":
        return { ok: true, value: kernel.subscriptions.lookup(...command.input.args) };
      case "subscriptions.delete":
        return { ok: true, value: kernel.subscriptions.delete(...command.input.args) };
      case "subscriptions.entries":
        return { ok: true, value: kernel.subscriptions.entries(...command.input.args) };
      case "attachments.register":
        return { ok: true, value: kernel.attachments.register(...command.input.args) };
      case "attachments.lookup":
        return { ok: true, value: kernel.attachments.lookup(...command.input.args) };
      case "attachments.delete":
        return { ok: true, value: kernel.attachments.delete(...command.input.args) };
      case "attachments.entries":
        return { ok: true, value: kernel.attachments.entries(...command.input.args) };
    }
  }
  return {
    execute(command) {
      if (command.type === "connection.open") {
        const connection = ++nextConnection;
        try {
          const unclaimed = connections.get(0);
          connections.delete(0);
          const kernel =
            unclaimed?.kernel ??
            createWorkboardSqliteKernel(
              context.databasePath,
              (close) => {
                connections.set(connection, { close });
              },
              admitWrite,
            );
          connections.set(connection, { kernel, close: kernel.close });
          return { ok: true, value: { connection, dataVersion: kernel.dataVersion() } };
        } catch (error) {
          const owned = connections.get(connection);
          if (owned) {
            try {
              owned.close();
              connections.delete(connection);
            } catch {
              return {
                ok: false,
                failure: { ...encodeWorkboardSqliteFailure(error), cleanupConnection: connection },
              };
            }
          }
          return { ok: false, failure: encodeWorkboardSqliteFailure(error) };
        }
      }
      try {
        guarded = "guarded" in command.input && command.input.guarded === true;
        return execute(command);
      } catch (error) {
        return { ok: false, failure: encodeWorkboardSqliteFailure(error) };
      } finally {
        guarded = false;
      }
    },
    close() {
      const failures: unknown[] = [];
      for (const [id, kernel] of connections) {
        try {
          kernel.close();
          connections.delete(id);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Workboard SQLite cleanup failed");
      }
    },
  };
}
