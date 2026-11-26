import type {
  WorkboardPersistence,
  WorkboardSourceCardInput,
  WorkboardSourceCardResult,
} from "./persistence-types.js";
import type { WorkboardSqliteResult } from "./sqlite-store-errors.js";

type Operation<Method extends (...args: never[]) => unknown> = {
  input: { args: Parameters<Method> };
  output: Awaited<ReturnType<Method>>;
};

type StoreMethods<Prefix extends string, Store> = {
  [Key in keyof Store & string as `${Prefix}.${Key}`]: Store[Key];
};

type WorkboardSqliteStoreMethods = StoreMethods<
  "cards",
  Omit<WorkboardPersistence["cards"], "registerSource">
> &
  StoreMethods<"resultReviews", NonNullable<WorkboardPersistence["resultReviews"]>> &
  StoreMethods<"boards", WorkboardPersistence["boards"]> &
  StoreMethods<"sessionsBoard", WorkboardPersistence["sessionsBoard"]> &
  StoreMethods<"subscriptions", WorkboardPersistence["subscriptions"]> &
  StoreMethods<"attachments", WorkboardPersistence["attachments"]>;

type WorkboardSqliteStoreOperations = {
  [Key in keyof WorkboardSqliteStoreMethods]: Operation<WorkboardSqliteStoreMethods[Key]>;
};

export type WorkboardSourceWorkerOperations = {
  create: {
    input: WorkboardSourceCardInput;
    output: WorkboardSqliteResult<WorkboardSourceCardResult>;
  };
};

export type WorkboardSqliteOperations = WorkboardSqliteStoreOperations;
export type WorkboardSqliteWorkerOperations = {
  [K in keyof WorkboardSqliteOperations]: {
    input: WorkboardSqliteOperations[K]["input"];
    output: WorkboardSqliteResult<WorkboardSqliteOperations[K]["output"]>;
  };
};
