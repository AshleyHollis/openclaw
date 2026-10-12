import { AsyncLocalStorage } from "node:async_hooks";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  runSessionTranscriptSourceAdmissionOperation,
  type PreparedSessionTranscriptSourceAdmission,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  openSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
  runSqliteWorkerStoreWrite,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  WorkboardCardStore,
  WorkboardKeyedStore,
  WorkboardSessionsBoardStore,
  WorkboardSubscriptionStore,
  WorkboardWriteAuthority,
} from "./persistence-types.js";
import { workboardSqliteSourceEntrypoint } from "./sqlite-source-entrypoint.js";
import type {
  WorkboardSqliteOperations,
  WorkboardSqliteWorkerOperations,
} from "./sqlite-store-contract.js";
import { unwrapWorkboardSqliteResult } from "./sqlite-store-errors.js";

type WorkboardSqliteStores = {
  cards: WorkboardCardStore;
  boards: WorkboardKeyedStore<PersistedWorkboardBoard>;
  sessionsBoard: WorkboardSessionsBoardStore;
  subscriptions: WorkboardSubscriptionStore;
  attachments: WorkboardKeyedStore<PersistedWorkboardAttachment>;
  ready: Promise<number>;
  dataVersion(this: void): Promise<number>;
  close(this: void): Promise<void>;
  runWithWriteAuthority: WorkboardWriteAuthority;
};

export function createWorkboardSqliteStores(options: {
  dbPath?: string;
  workerModuleUrl: URL;
}): WorkboardSqliteStores {
  const databasePath = path.resolve(
    options.dbPath ?? path.join(resolveStateDir(), "plugins", "workboard", "workboard.sqlite"),
  );
  const worker = openSqliteWorkerStore<WorkboardSqliteWorkerOperations>({
    moduleUrl: options.workerModuleUrl,
    databasePath,
    input: undefined,
  });
  let ownedConnection: number | undefined;
  let brokerClosed = false;
  let brokerCleanup = false;
  let sealed = false;
  let openingFailure: { error: unknown } | undefined;
  let closing: Promise<void> | undefined;
  const operations = new Set<Promise<unknown>>();
  const writeAuthority = new AsyncLocalStorage<{
    active: boolean;
    assertCurrent?: () => void;
    sourceAdmission?: PreparedSessionTranscriptSourceAdmission;
  }>();
  async function cleanup() {
    // Rejected admission stays broker-owned; this facade received no lease to release.
    const store = await worker.catch(() => undefined);
    if (!store) {
      return;
    }
    if (ownedConnection !== undefined && !brokerCleanup) {
      const result = await store
        .execute({ type: "connection.close", input: { connection: ownedConnection } })
        .catch((error: unknown) => {
          const code = extractErrorCode(error);
          if (code === "closed" || code === "unavailable" || code === "outcome-unknown") {
            // Terminal transport cleanup belongs to the broker's joined retirement.
            brokerCleanup = true;
            return undefined;
          }
          throw error;
        });
      if (result !== undefined) {
        unwrapWorkboardSqliteResult(result);
        ownedConnection = undefined;
      }
    }
    if (!brokerClosed) {
      await store.close();
      brokerClosed = true;
      ownedConnection = undefined;
    }
  }
  const opened = worker
    .then(async (store) => {
      const result = await store.execute({ type: "connection.open", input: undefined });
      if (result.ok) {
        ownedConnection = result.value.connection;
        return result.value;
      }
      ownedConnection = result.failure.cleanupConnection;
      return unwrapWorkboardSqliteResult<WorkboardSqliteOperations["connection.open"]["output"]>(
        result,
      );
    })
    .catch(async (error: unknown) => {
      openingFailure = { error };
      sealed = true;
      if (ownedConnection === undefined) {
        try {
          await cleanup();
        } catch {
          /* Explicit close retains the failed broker cleanup. */
        }
      }
      throw error;
    });
  const ready = opened.then((value) => value.dataVersion);
  void ready.catch(() => {});
  async function execute<K extends keyof WorkboardSqliteOperations>(
    type: K,
    input: WorkboardSqliteOperations[K]["input"],
    writes = false,
  ): Promise<WorkboardSqliteOperations[K]["output"]> {
    const authority = writes ? writeAuthority.getStore() : undefined;
    const store = await worker;
    if (!authority) {
      return unwrapWorkboardSqliteResult(await store.execute({ type, input }));
    }
    const assertCurrent = () => {
      if (!authority.active) {
        throw new Error("Workboard mutation authority has settled.");
      }
      authority.assertCurrent?.();
    };
    const sourceAdmission = authority.sourceAdmission;
    const sourceWorker = async () => {
      if (
        type !== "cards.register" &&
        type !== "cards.registerIfAbsent" &&
        type !== "cards.registerIdempotent"
      ) {
        throw new Error("Workboard source admission only accepts card creation.");
      }
      const canonicalPath = await realpath(databasePath);
      const identity = await stat(canonicalPath, { bigint: true });
      assertCurrent();
      return await runSessionTranscriptSourceAdmissionOperation<WorkboardSqliteWorkerOperations, K>(
        sourceAdmission!,
        {
          moduleUrl: resolveRuntimeWorkerUrl(workboardSqliteSourceEntrypoint),
          input: {
            databasePath: canonicalPath,
            destinationIdentity: {
              dev: identity.dev.toString(),
              ino: identity.ino.toString(),
              birthtime: identity.birthtimeNs.toString(),
            },
          },
        },
        { type, input },
        assertCurrent,
      );
    };
    const result = unwrapWorkboardSqliteResult(
      sourceAdmission
        ? await sourceWorker()
        : type.startsWith("cards.")
          ? await runSqliteWorkerStoreWrite(
              store,
              (scope) => scope.execute({ type, input: { ...input, guarded: true } }),
              assertCurrent,
              [databasePath],
            )
          : await runSqliteWorkerStoreOperation(
              store,
              (scope) => scope.execute({ type, input }),
              undefined,
              assertCurrent,
            ),
    );
    // A rejected comparison has accepted no mutation; a retry still needs authority.
    if (
      result !== undefined &&
      result !== false &&
      result !== "conflict" &&
      result !== "owner_busy"
    ) {
      authority.assertCurrent = undefined;
      authority.sourceAdmission = undefined;
    }
    return result;
  }
  async function run<Args, T>(
    args: Args,
    operation: (connection: number, captured: Args) => Promise<T>,
  ): Promise<T> {
    if (openingFailure) {
      throw openingFailure.error;
    }
    if (sealed) {
      throw new Error("Workboard SQLite connection is closed.");
    }
    const captured = structuredClone(args);
    const pending = opened.then(({ connection }) => operation(connection, captured));
    operations.add(pending);
    try {
      return await pending;
    } finally {
      operations.delete(pending);
    }
  }
  function bindOperation<Args extends unknown[], Result>(
    operation: (input: { connection: number; args: Args }) => Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    return (...args) =>
      run(args, (connection, captured) => operation({ connection, args: captured }));
  }
  return {
    async runWithWriteAuthority(assertCurrent, operation, sourceAdmission) {
      const authority: {
        active: boolean;
        assertCurrent?: () => void;
        sourceAdmission?: PreparedSessionTranscriptSourceAdmission;
      } = {
        active: true,
        assertCurrent,
        sourceAdmission,
      };
      try {
        return await writeAuthority.run(authority, operation);
      } finally {
        authority.active = false;
        await sourceAdmission?.close();
      }
    },
    ready,
    dataVersion: () => run(undefined, (connection) => execute("dataVersion", { connection })),
    cards: {
      register: bindOperation((input) => execute("cards.register", input, true)),
      registerIfAbsent: bindOperation((input) => execute("cards.registerIfAbsent", input, true)),
      registerIfUpdatedAt: bindOperation((input) =>
        execute("cards.registerIfUpdatedAt", input, true),
      ),
      claimIfOwnerAvailable: bindOperation((input) =>
        execute("cards.claimIfOwnerAvailable", input, true),
      ),
      deleteIfUpdatedAt: bindOperation((input) => execute("cards.deleteIfUpdatedAt", input, true)),
      lookup: bindOperation((input) => execute("cards.lookup", input)),
      delete: bindOperation((input) => execute("cards.delete", input, true)),
      entries: bindOperation((input) => execute("cards.entries", input)),
      listCardStatuses: bindOperation((input) => execute("cards.listCardStatuses", input)),
      listBoardAggregates: bindOperation((input) => execute("cards.listBoardAggregates", input)),
      listStatsAggregates: bindOperation((input) => execute("cards.listStatsAggregates", input)),
      hasCards: bindOperation((input) => execute("cards.hasCards", input)),
      registerIdempotent: bindOperation((input) =>
        execute("cards.registerIdempotent", input, true),
      ),
      registerWithResultReview: bindOperation((input) =>
        execute("cards.registerWithResultReview", input, true),
      ),
      getResultReview: bindOperation((input) => execute("cards.getResultReview", input)),
      listResultReviews: bindOperation((input) => execute("cards.listResultReviews", input)),
      resolveResultReview: bindOperation((input) =>
        execute("cards.resolveResultReview", input, true),
      ),
    },
    boards: {
      register: bindOperation((input) => execute("boards.register", input, true)),
      lookup: bindOperation((input) => execute("boards.lookup", input)),
      delete: bindOperation((input) => execute("boards.delete", input, true)),
      entries: bindOperation((input) => execute("boards.entries", input)),
    },
    sessionsBoard: {
      get: bindOperation((input) => execute("sessionsBoard.get", input)),
      update: bindOperation((input) => execute("sessionsBoard.update", input, true)),
      listPlacements: bindOperation((input) => execute("sessionsBoard.listPlacements", input)),
      repairPlacements: bindOperation((input) =>
        execute("sessionsBoard.repairPlacements", input, true),
      ),
      writePlacement: bindOperation((input) =>
        execute("sessionsBoard.writePlacement", input, true),
      ),
    },
    subscriptions: {
      register: bindOperation((input) => execute("subscriptions.register", input, true)),
      lookup: bindOperation((input) => execute("subscriptions.lookup", input)),
      delete: bindOperation((input) => execute("subscriptions.delete", input, true)),
      entries: bindOperation((input) => execute("subscriptions.entries", input)),
    },
    attachments: {
      register: bindOperation((input) => execute("attachments.register", input, true)),
      lookup: bindOperation((input) => execute("attachments.lookup", input)),
      delete: bindOperation((input) => execute("attachments.delete", input, true)),
      entries: bindOperation((input) => execute("attachments.entries", input)),
    },
    close() {
      sealed = true;
      closing ??= Promise.resolve()
        .then(async () => {
          while (operations.size) {
            await Promise.allSettled(operations);
          }
          await opened.catch(() => undefined);
          await cleanup();
        })
        .catch((error: unknown) => {
          closing = undefined;
          throw error;
        });
      return closing;
    },
  };
}
