import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkboardCard, WorkboardResultReviewRequest } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteKernel } from "./sqlite-store-kernel.js";

const card: WorkboardCard = {
  id: "card",
  title: "Fictional report",
  status: "running",
  priority: "normal",
  labels: [],
  position: 0,
  createdAt: 1,
  updatedAt: 2,
  sessionKey: "session",
  runId: "run",
  metadata: { automation: { tenant: "", boardId: "default" } },
};
const completed: WorkboardCard = { ...card, status: "review", updatedAt: 3 };
const request: WorkboardResultReviewRequest = {
  schemaVersion: 1,
  id: "request",
  requestRevision: "a".repeat(64),
  resultDigest: "b".repeat(64),
  completionIntent: "c".repeat(64),
  revision: 1,
  status: "pending",
  tenant: "",
  boardId: "default",
  cardId: "card",
  sessionKey: "session",
  runId: "run",
  createdAt: 3,
  expiresAt: null,
  resolvedAt: null,
  result: { summary: "Please review the completed report", proof: [], artifacts: [] },
};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workboard-result-review-"));
  const dbPath = path.join(dir, "workboard.sqlite");
  const kernels: ReturnType<typeof createWorkboardSqliteKernel>[] = [];
  return {
    dbPath,
    open(guard?: (stage: "transaction" | "commit") => void) {
      const kernel = createWorkboardSqliteKernel(dbPath);
      kernels.push(kernel);
      if (!guard) {
        return kernel;
      }
      const withAuthority = <T>(operation: () => T): T =>
        kernel.withWriteTransaction(
          () => {
            guard("transaction");
            return operation();
          },
          {
            withCommit(commit) {
              guard("commit");
              commit();
            },
          },
        );
      return {
        ...kernel,
        resultReviews: {
          ...kernel.resultReviews,
          register: (...args) => withAuthority(() => kernel.resultReviews.register(...args)),
          resolve: (...args) => withAuthority(() => kernel.resultReviews.resolve(...args)),
        },
      };
    },
    close() {
      for (const kernel of kernels) {
        kernel.close();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("durable Workboard result review owner", () => {
  it.each(["get", "list", "withdraw"])(
    "refuses malformed retained proof before %s exposes or changes the snapshot",
    (operation) => {
      const f = fixture();
      try {
        const k = f.open();
        k.cards.register(card.id, { version: 1, card });
        k.resultReviews.register(card.id, { version: 1, card: completed }, 2, request);
        const malformed = {
          ...request,
          result: { ...request.result, proof: [{ id: "proof", status: "invented", createdAt: 3 }] },
        };
        const db = new DatabaseSync(f.dbPath);
        try {
          db.prepare("UPDATE workboard_result_reviews SET request_json = ? WHERE id = ?").run(
            JSON.stringify(malformed),
            request.id,
          );
        } finally {
          db.close();
        }
        expect(() => {
          if (operation === "get") {
            k.resultReviews.get(request.id);
          } else if (operation === "list") {
            k.resultReviews.list({ tenant: "", boardId: "default", cardId: card.id });
          } else {
            k.cards.register(card.id, { version: 1, card: { ...completed, status: "done" } });
          }
        }).toThrow();
        expect(k.cards.lookup(card.id)?.card).toEqual(completed);
      } finally {
        f.close();
      }
    },
  );
  it("keeps an ordinary card database portable until the first authorized review", () => {
    const f = fixture();
    try {
      const k = f.open();
      k.cards.register(card.id, { version: 1, card });
      expect(k.resultReviews.list({ tenant: "", boardId: "default", cardId: card.id })).toEqual([]);
      const db = new DatabaseSync(f.dbPath, { readOnly: true });
      try {
        const table = db.prepare(
          "SELECT 1 FROM sqlite_schema WHERE name = 'workboard_result_reviews'",
        );
        expect(table.get()).toBeUndefined();
        expect(
          k.resultReviews.register(card.id, { version: 1, card: completed }, 2, request),
        ).toMatchObject({ inserted: true });
        expect(table.get()).toBeDefined();
      } finally {
        db.close();
      }
    } finally {
      f.close();
    }
  });
  it("admits one exact snapshot across competing connections, response loss and reopen", () => {
    const f = fixture();
    try {
      const first = f.open();
      const second = f.open();
      first.cards.register(card.id, { version: 1, card });
      expect(
        first.resultReviews.register(card.id, { version: 1, card: completed }, 2, request),
      ).toMatchObject({ inserted: true });
      const retry = {
        ...request,
        requestRevision: "d".repeat(64),
        resultDigest: "e".repeat(64),
        result: { ...request.result, summary: "regenerated noise" },
      };
      expect(
        second.resultReviews.register(
          card.id,
          { version: 1, card: { ...completed, updatedAt: 99 } },
          2,
          retry,
        ),
      ).toMatchObject({ inserted: false });
      expect(second.resultReviews.get(request.id)).toEqual(request);
      expect(second.cards.lookup(card.id)?.card.updatedAt).toBe(3);
      expect(() =>
        second.resultReviews.register(card.id, { version: 1, card: completed }, 2, {
          ...request,
          completionIntent: "f".repeat(64),
        }),
      ).toThrow(/immutable intent/);
      expect(() =>
        second.resultReviews.register(card.id, { version: 1, card: completed }, 3, {
          ...request,
          id: "another",
        }),
      ).toThrow();
      const reopened = f.open();
      expect(
        reopened.resultReviews.list({ tenant: "", boardId: "default", cardId: card.id }),
      ).toEqual([request]);
      expect(
        reopened.resultReviews.list({ tenant: "other", boardId: "default", cardId: card.id }),
      ).toEqual([]);
    } finally {
      f.close();
    }
  });

  it("resolves only exact revisions and never revives terminal evidence", () => {
    const f = fixture();
    try {
      const k = f.open();
      k.cards.register(card.id, { version: 1, card });
      k.resultReviews.register(card.id, { version: 1, card: completed }, 2, request);
      expect(k.resultReviews.resolve(request.id, 2, 3, "reviewed", 4)).toBeUndefined();
      expect(k.resultReviews.resolve(request.id, 1, 2, "reviewed", 4)).toBeUndefined();
      const resolved = k.resultReviews.resolve(request.id, 1, 3, "reviewed", 4);
      expect(resolved?.request).toMatchObject({ status: "reviewed", revision: 2, resolvedAt: 4 });
      expect(resolved?.card).toMatchObject({ status: "done", updatedAt: 4 });
      expect(k.resultReviews.resolve(request.id, 1, 4, "withdrawn", 5)).toBeUndefined();
      expect(
        k.resultReviews.register(card.id, { version: 1, card: completed }, 2, request),
      ).toMatchObject({ inserted: false });
      expect(f.open().resultReviews.get(request.id)?.status).toBe("reviewed");
      expect(k.cards.lookup(card.id)?.card.status).toBe("done");
    } finally {
      f.close();
    }
  });

  it.each(["done", "archive", "delete"] as const)(
    "withdraws on generic %s while retaining the receipt",
    (action) => {
      const f = fixture();
      try {
        const k = f.open();
        k.cards.register(card.id, { version: 1, card });
        k.resultReviews.register(card.id, { version: 1, card: completed }, 2, request);
        if (action === "delete") {
          k.cards.deleteIfUpdatedAt(card.id, 3);
        } else {
          k.cards.registerIfUpdatedAt(
            card.id,
            {
              version: 1,
              card: {
                ...completed,
                updatedAt: 4,
                ...(action === "done"
                  ? { status: "done" }
                  : { metadata: { ...completed.metadata, archivedAt: 4 } }),
              },
            },
            3,
          );
        }
        expect(f.open().resultReviews.get(request.id)).toMatchObject({
          status: "withdrawn",
          revision: 2,
        });
      } finally {
        f.close();
      }
    },
  );

  it("explicit withdrawal keeps the card in Review and freezes the terminal receipt", () => {
    const f = fixture();
    try {
      const k = f.open();
      k.cards.register(card.id, { version: 1, card });
      k.resultReviews.register(card.id, { version: 1, card: completed }, 2, request);
      expect(k.resultReviews.resolve(request.id, 1, 3, "withdrawn", 4)).toMatchObject({
        request: { status: "withdrawn", revision: 2, resolvedAt: 4 },
        card: { status: "review", updatedAt: 4 },
      });
      expect(f.open().resultReviews.get(request.id)?.result).toEqual(request.result);
    } finally {
      f.close();
    }
  });

  it("rolls back both the card and request when commit authority is revoked", () => {
    const f = fixture();
    let deny = false;
    try {
      const k = f.open((stage) => {
        if (deny && stage === "commit") {
          throw new Error("authority revoked");
        }
      });
      k.cards.register(card.id, { version: 1, card });
      deny = true;
      expect(() =>
        k.resultReviews.register(card.id, { version: 1, card: completed }, 2, request),
      ).toThrow(/revoked/);
      expect(k.resultReviews.get(request.id)).toBeUndefined();
      expect(k.cards.lookup(card.id)?.card.status).toBe("running");
      deny = false;
      k.resultReviews.register(card.id, { version: 1, card: completed }, 2, request);
      deny = true;
      expect(() => k.resultReviews.resolve(request.id, 1, 3, "reviewed", 4)).toThrow(/revoked/);
      expect(k.resultReviews.get(request.id)?.status).toBe("pending");
      expect(k.cards.lookup(card.id)?.card.status).toBe("review");
    } finally {
      f.close();
    }
  });
  it("rechecks the existing native dependency hold inside review resolution commit", () => {
    const f = fixture();
    try {
      const k = f.open();
      k.cards.register("parent", { version: 1, card: { ...card, id: "parent", status: "done" } });
      const links = [
        { id: "parent-link", type: "parent" as const, targetCardId: "parent", createdAt: 1 },
      ];
      k.cards.register(card.id, {
        version: 1,
        card: { ...card, metadata: { ...card.metadata, links } },
      });
      k.resultReviews.register(
        card.id,
        { version: 1, card: { ...completed, metadata: { ...completed.metadata, links } } },
        card.updatedAt,
        request,
      );
      k.cards.register("parent", { version: 1, card: { ...card, id: "parent", status: "review" } });
      expect(() =>
        k.resultReviews.resolve(request.id, 1, completed.updatedAt, "reviewed", 10),
      ).toThrow(/dependencies are not done/);
      expect(k.resultReviews.get(request.id)?.status).toBe("pending");
      expect(k.cards.lookup(card.id)?.card.status).toBe("review");
    } finally {
      f.close();
    }
  });
});
