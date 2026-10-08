import { vi } from "vitest";
import * as nativeAdmission from "../../src/infra/sqlite-worker-operation-admission.js";

/** Observe the real request while delegating its unchanged native admission and grant. */
export function observeSqliteWorkerAdmissionForTest() {
  let current: nativeAdmission.SqliteWorkerAdmissionRequest | undefined;
  const create = nativeAdmission.createSqliteWorkerOperationAdmission;
  const spy = vi
    .spyOn(nativeAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      create((request, grant) => {
        const previous = current;
        current = request;
        try {
          admit(request, grant);
        } finally {
          current = previous;
        }
      }, attachment),
    );
  return {
    get currentRequest() {
      return current;
    },
    restore() {
      spy.mockRestore();
    },
  };
}
