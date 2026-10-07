/** Static publisher entry shared by source and packaged runtime resolution. */
export const workboardSqliteSourceEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "sqlite-store-source.worker",
  distWorkerPath: "extensions/workboard/src/sqlite-store-source.worker.js",
} as const;
