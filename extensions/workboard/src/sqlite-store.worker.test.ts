import { beforeEach, describe, expect, it, vi } from "vitest";

const { createWorkboardSqliteKernel, requestSqliteWorkerOperationAdmission } = vi.hoisted(() => ({
  createWorkboardSqliteKernel: vi.fn(),
  requestSqliteWorkerOperationAdmission: vi.fn(),
}));
vi.mock("./sqlite-store-kernel.js", () => ({ createWorkboardSqliteKernel }));
vi.mock("openclaw/plugin-sdk/sqlite-worker-runtime", () => ({
  requestSqliteWorkerOperationAdmission,
}));

import { createSqliteWorkerBackend } from "./sqlite-store.worker.js";

function fixture() {
  const card = { id: "synthetic-card" };
  let admitWrite: (stage: "transaction" | "commit") => void = () => {};
  const kernel = {
    close: vi.fn(),
    dataVersion: vi.fn(() => 17),
    cards: {
      lookup: vi.fn(() => card),
      entries: vi.fn(() => [{ key: "synthetic-card", value: card }]),
      hasCards: vi.fn(() => false),
      delete: vi.fn(() => {
        admitWrite("transaction");
        admitWrite("commit");
        return true;
      }),
    },
    boards: { lookup: vi.fn(() => undefined) },
  };
  createWorkboardSqliteKernel.mockImplementation(
    (_path: string, _close: unknown, admission: typeof admitWrite) => {
      admitWrite = admission;
      return kernel;
    },
  );
  const backend = createSqliteWorkerBackend(undefined, { databasePath: "/synthetic-workboard" });
  expect(backend.execute({ type: "connection.open", input: undefined })).toEqual({
    ok: true,
    value: { connection: 1, dataVersion: 17 },
  });
  return { backend, kernel, card };
}

beforeEach(() => {
  createWorkboardSqliteKernel.mockReset();
  requestSqliteWorkerOperationAdmission.mockReset();
});

describe("Workboard SQLite worker replies", () => {
  it("preserves distinct operation results and forwards the original arguments", () => {
    const { backend, kernel, card } = fixture();
    expect(backend.execute({ type: "dataVersion", input: { connection: 1 } })).toEqual({
      ok: true,
      value: 17,
    });
    expect(
      backend.execute({ type: "cards.lookup", input: { connection: 1, args: ["synthetic-card"] } }),
    ).toEqual({ ok: true, value: card });
    expect(backend.execute({ type: "cards.entries", input: { connection: 1, args: [] } })).toEqual({
      ok: true,
      value: [{ key: "synthetic-card", value: card }],
    });
    expect(
      backend.execute({ type: "cards.hasCards", input: { connection: 1, args: ["board"] } }),
    ).toEqual({
      ok: true,
      value: false,
    });
    expect(
      backend.execute({ type: "boards.lookup", input: { connection: 1, args: ["missing"] } }),
    ).toEqual({ ok: true, value: undefined });
    expect(kernel.cards.lookup).toHaveBeenCalledExactlyOnceWith("synthetic-card");
    expect(kernel.boards.lookup).toHaveBeenCalledExactlyOnceWith("missing");
    backend.close();
  });

  it("retains both write authority boundaries and the mutation result", () => {
    const { backend, kernel } = fixture();
    expect(
      backend.execute({
        type: "cards.delete",
        input: { connection: 1, args: ["synthetic-card"], guarded: true },
      }),
    ).toEqual({ ok: true, value: true });
    expect(requestSqliteWorkerOperationAdmission.mock.calls).toEqual([
      [{ stage: "transaction", facts: undefined }],
      [{ stage: "commit", facts: undefined }],
    ]);
    expect(kernel.cards.delete).toHaveBeenCalledExactlyOnceWith("synthetic-card");
    backend.close();
  });

  it("encodes authority refusal and resets the guard before the next command", () => {
    const { backend } = fixture();
    const refusal = Object.assign(new Error("authority revoked"), { code: "unavailable" });
    requestSqliteWorkerOperationAdmission.mockImplementationOnce(() => {
      throw refusal;
    });
    expect(
      backend.execute({
        type: "cards.delete",
        input: { connection: 1, args: ["synthetic-card"], guarded: true },
      }),
    ).toEqual({ ok: false, failure: { error: refusal, name: "Error", code: "unavailable" } });
    expect(
      backend.execute({ type: "cards.delete", input: { connection: 1, args: ["synthetic-card"] } }),
    ).toEqual({ ok: true, value: true });
    expect(requestSqliteWorkerOperationAdmission).toHaveBeenCalledOnce();
    backend.close();
  });

  it("releases a closed connection once and refuses later operations", () => {
    const { backend, kernel } = fixture();
    expect(backend.execute({ type: "connection.close", input: { connection: 1 } })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(
      backend.execute({ type: "cards.lookup", input: { connection: 1, args: ["synthetic-card"] } }),
    ).toMatchObject({
      ok: false,
      failure: { error: new Error("Workboard SQLite connection is closed.") },
    });
    expect(kernel.cards.lookup).not.toHaveBeenCalled();
    backend.close();
    expect(kernel.close).toHaveBeenCalledOnce();
  });
});
