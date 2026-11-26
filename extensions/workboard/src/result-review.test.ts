import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import { observeSqliteWorkerAdmissionForTest } from "../../../test/helpers/sqlite-worker-admission-observer.js";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardResultReviewMethods } from "./gateway-result-review.js";
import { WorkboardStore } from "./store.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

type GatewayMethodContext = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];

const original: WorkboardCard = {
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
  metadata: {
    automation: { tenant: "", boardId: "default" },
    attempts: [
      { id: "attempt", sessionKey: "session", runId: "run", status: "running", startedAt: 1 },
    ],
  },
};
const input = {
  expectedUpdatedAt: 2,
  resultReview: { logicalOperationId: "review-report-v1" },
  summary: "Review the fictional completed report.",
  proof: { status: "passed", label: "Report checks" },
};
const scope = { tenant: "", boardId: "default", cardId: "card" };

async function fixture(run: (first: WorkboardStore, second: WorkboardStore) => Promise<void>) {
  // openclaw-temp-dir: allow closes both SQLite owners before removing test data.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-result-review-"));
  const dbPath = path.join(dir, "workboard.sqlite");
  const firstStores = createKernelStores(dbPath),
    secondStores = createKernelStores(dbPath);
  const create = (stores: typeof firstStores) =>
    new WorkboardStore(stores.cards, {
      ...stores,
      runWithWriteAuthority: async (assertCurrent, operation) => {
        assertCurrent();
        const result = await operation();
        assertCurrent();
        return result;
      },
    });
  const first = create(firstStores),
    second = create(secondStores);
  try {
    await firstStores.cards.register(original.id, { version: 1, card: structuredClone(original) });
    await run(first, second);
  } finally {
    await first.close();
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("explicit native completed-result review", () => {
  it("carries durable result review through the actual worker and preserves terminal promotion refusal", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    await stores.cards.register(original.id, { version: 1, card: structuredClone(original) });
    const completed = await store.complete(original.id, input, null, () => {});
    expect(completed.status).toBe("review");
    const [request] = await store.listResultReviews(scope, () => {});
    expect(request).toBeDefined();
    expect(await store.getResultReview({ ...scope, requestId: request!.id }, () => {})).toEqual(
      request,
    );
    expect(request!.result.proof).toEqual(completed.metadata?.proof);
    const resolved = await store.resolveResultReview(
      {
        ...scope,
        requestId: request!.id,
        expectedRevision: request!.revision,
        expectedUpdatedAt: completed.updatedAt,
        decision: "reviewed",
      },
      () => {},
    );
    expect(resolved.card.status).toBe("done");
    expect(resolved.request).toMatchObject({ status: "reviewed", revision: 2 });
    expect(resolved.request.result).toEqual(request!.result);
    await expect(store.complete(original.id, input, null, () => {})).resolves.toEqual(
      resolved.card,
    );
    await expect(store.promote(original.id, {}, null)).rejects.toThrow(
      "Cannot promote Workboard card in done",
    );
    expect(
      (await store.getResultReview({ ...scope, requestId: request!.id }, () => {})).result,
    ).toEqual(request!.result);
  });
  it("rolls back both the result and card when authority retires at the actual worker commit", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    await stores.cards.register(original.id, { version: 1, card: structuredClone(original) });
    const before = await store.get(original.id);
    const observer = observeSqliteWorkerAdmissionForTest();
    let denied = false;
    try {
      await expect(
        store.complete(original.id, input, null, () => {
          if (observer.currentRequest?.stage === "commit") {
            denied = true;
            throw new Error("Fictional review authority revoked");
          }
        }),
      ).rejects.toThrow("SQLite transaction admission was refused");
      expect(denied).toBe(true);
    } finally {
      observer.restore();
    }
    expect(await store.get(original.id)).toEqual(before);
    expect(await store.listResultReviews(scope, () => {})).toEqual([]);
  });
  it("concurrent completions return one authoritative immutable snapshot; retries never revive reviewed work", async () =>
    fixture(async (first, second) => {
      const cards = await Promise.all([
        first.complete("card", input, null, () => {}),
        second.complete("card", input, null, () => {}),
      ]);
      expect(cards[0]).toEqual(cards[1]);
      expect(cards[0].status).toBe("review");
      const requests = await first.listResultReviews(scope, () => {});
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.requestRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(request.resultDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(request.expiresAt).toBeNull();
      expect(request.result.proof).toEqual(cards[0].metadata?.proof);
      await expect(
        first.complete("card", { ...input, summary: "Changed intent" }, null, () => {}),
      ).rejects.toThrow(/intent changed/);
      const resolved = await first.resolveResultReview(
        {
          ...scope,
          requestId: request.id,
          expectedRevision: request.revision,
          expectedUpdatedAt: cards[0].updatedAt,
          decision: "reviewed",
        },
        () => {},
      );
      expect(resolved.card.status).toBe("done");
      expect(resolved.request.status).toBe("reviewed");
      expect(resolved.request.requestRevision).toBe(request.requestRevision);
      expect(await second.complete("card", input, null, () => {})).toEqual(resolved.card);
      expect(await second.getResultReview({ ...scope, requestId: request.id }, () => {})).toEqual(
        resolved.request,
      );
    }));

  it("fails closed on missing current authority, stale revision, unrelated run, and scope changes", async () =>
    fixture(async (first) => {
      await expect(first.complete("card", input, null)).rejects.toThrow(/current native authority/);
      await expect(
        first.complete("card", { ...input, expectedUpdatedAt: 3 }, null, () => {}),
      ).rejects.toThrow(/no longer running/);
      await first.update("card", { runId: "unrelated" });
      await expect(
        first.complete(
          "card",
          { ...input, expectedUpdatedAt: (await first.get("card"))!.updatedAt },
          null,
          () => {},
        ),
      ).rejects.toThrow(/no longer running/);
      await expect(
        first.listResultReviews({ ...scope, tenant: "other" }, () => {}),
      ).rejects.toThrow(/scope changed/);
    }));

  it("ordinary completion remains Done and creates no explicit human request", async () =>
    fixture(async (first) => {
      const card = await first.complete("card", { summary: "Routine completed report." }, null);
      expect(card.status).toBe("done");
      expect(await first.listResultReviews(scope, () => {})).toEqual([]);
    }));

  it("deletion retains terminal proof and cannot leave a pending actionable request", async () =>
    fixture(async (first) => {
      const card = await first.complete("card", input, null, () => {});
      const request = (await first.listResultReviews(scope, () => {}))[0]!;
      await first.delete(card.id, { expectedUpdatedAt: card.updatedAt });
      const terminal = await first.getResultReview({ ...scope, requestId: request.id }, () => {});
      expect(terminal.status).toBe("withdrawn");
      expect(terminal.result).toEqual(request.result);
    }));
  it("fences authenticated private delivery after the owner read and refuses asynchronous authority", async () =>
    fixture(async (first) => {
      await first.complete("card", input, null, () => {});
      const handlers = new Map<string, (context: GatewayMethodContext) => unknown>();
      const scopes = new Map<string, unknown>();
      registerWorkboardResultReviewMethods(
        {
          registerGatewayMethod(method, handler, options) {
            handlers.set(method, handler);
            scopes.set(method, options?.scope);
          },
        },
        first,
      );
      expect(scopes.get("workboard.resultReviews.list")).toBe("operator.read");
      expect(scopes.get("workboard.resultReviews.resolve")).toBe("operator.write");
      const ownerRead = first.listResultReviews.bind(first);
      let current = true;
      first.listResultReviews = async (...args) => {
        const result = await ownerRead(...args);
        queueMicrotask(() => {
          current = false;
        });
        return result;
      };
      const delivered: unknown[][] = [];
      const request = {
        params: scope,
        respond: (...args: unknown[]) => delivered.push(args),
        sessionMutationAuthorization: {
          assertCurrent: () => {
            if (!current) {
              throw new Error("Principal retired before publication");
            }
          },
        },
      };
      await handlers.get("workboard.resultReviews.list")!(request as never);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]![0]).toBe(false);
      expect(delivered[0]![1]).toBeUndefined();
      delivered.length = 0;
      current = true;
      // Model a malformed runtime callback without claiming it satisfies the void contract.
      const malformedCurrent: unknown = () => Promise.resolve();
      Reflect.set(request.sessionMutationAuthorization, "assertCurrent", malformedCurrent);
      await handlers.get("workboard.resultReviews.list")!(request as never);
      expect(delivered[0]![0]).toBe(false);
      expect(delivered[0]![1]).toBeUndefined();
    }));
  it.each([undefined, "failed" as const])(
    "preserves native Done semantics for proof status %s",
    async (status: "failed" | undefined) =>
      fixture(async (first) => {
        const card = await first.complete(
          "card",
          { ...input, proof: status ? { status, label: "Failed check" } : undefined },
          null,
          () => {},
        );
        const request = (await first.listResultReviews(scope, () => {}))[0]!;
        expect(request.result.proof.map((proof) => proof.status)).toEqual(status ? [status] : []);
        const result = await first.resolveResultReview(
          {
            ...scope,
            requestId: request.id,
            expectedRevision: request.revision,
            expectedUpdatedAt: card.updatedAt,
            decision: "reviewed",
          },
          () => {},
        );
        expect(result.card.status).toBe("done");
      }),
  );
  it("binds explicit worker completion to the trusted original session and run", async () =>
    fixture(async (first) => {
      const completion = (runId: string | undefined) =>
        createWorkboardTools({
          store: first,
          context: {
            agentId: "main",
            sessionKey: "session",
            runId,
            assertInvocationCurrent: () => {},
          },
        }).find((tool) => tool.name === "workboard_complete")!;
      await expect(
        completion(undefined).execute("missing-run", { id: "card", ...input }),
      ).rejects.toThrow(/current native session invocation/);
      await expect(
        completion("later-unrelated-run").execute("wrong-run", { id: "card", ...input }),
      ).rejects.toThrow(/exact producing card session and run/);
      expect(await first.listResultReviews(scope, () => {})).toEqual([]);
      await completion("run").execute("exact-run", { id: "card", ...input });
      expect((await first.get("card"))?.status).toBe("review");
      expect(await first.listResultReviews(scope, () => {})).toHaveLength(1);
    }));
});
