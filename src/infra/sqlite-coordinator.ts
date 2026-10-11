import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { isSqliteLockError, withSqliteNativeOpen } from "./sqlite-error-diagnostics.js";
import { sqliteWriteAdmissionServicesForLocation } from "./sqlite-transaction.js";

export type SqliteCoordinatorLease = {
  readonly closed: boolean;
  release: () => void;
};

/**
 * Hold a contentless exclusive SQLite lock across filesystem and metadata work.
 * This is a lock primitive, not a state-store connection: it never commits data.
 * The caller supplies a dedicated coordinator path in its private directory.
 */
export function tryAcquireExclusiveSqliteCoordinator(
  location: string,
  options: { busyTimeoutMs?: number } = {},
): SqliteCoordinatorLease | null {
  const busyTimeoutMs = options.busyTimeoutMs ?? 0;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError("SQLite coordinator busy timeout must be a nonnegative safe integer");
  }
  const database = withSqliteNativeOpen(() => openNodeSqliteDatabase(location));
  try {
    acquire(database, location, busyTimeoutMs);
  } catch (error) {
    try {
      database.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "SQLite coordinator acquisition and close failed",
        {
          cause: error,
        },
      );
    }
    if (isSqliteLockError(error)) {
      return null;
    }
    throw error;
  }
  return {
    get closed() {
      return !database.isOpen;
    },
    release() {
      if (!database.isOpen) {
        return;
      }
      const errors: unknown[] = [];
      if (database.isTransaction) {
        try {
          database.exec("ROLLBACK");
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        database.close();
      } catch (error) {
        errors.push(error);
      }
      // A failed native close can be retried; a physically closed lease is terminal.
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "SQLite coordinator rollback and close failed", {
          cause: errors[0],
        });
      }
    },
  };
}

function acquire(database: DatabaseSync, location: string, busyTimeoutMs: number): void {
  const services = sqliteWriteAdmissionServicesForLocation(location);
  const deadline = performance.now() + busyTimeoutMs;
  for (;;) {
    const attemptTimeout = services
      ? Math.min(25, Math.max(0, Math.ceil(deadline - performance.now())))
      : busyTimeoutMs;
    try {
      // MEMORY avoids journal artifacts; apply the bounded timeout before any lock attempt.
      database.exec(
        `PRAGMA busy_timeout = ${attemptTimeout}; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE;`,
      );
      return;
    } catch (error) {
      if (!services || !isSqliteLockError(error) || performance.now() >= deadline) {
        throw error;
      }
      for (const service of services) {
        service();
      }
    }
  }
}
