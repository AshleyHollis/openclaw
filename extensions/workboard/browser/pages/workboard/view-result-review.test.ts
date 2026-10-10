import "../../test/dom.setup.ts";
import type { WorkboardResultReviewRequest } from "@openclaw/workboard-contract";
import { nothing, render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { renderCardDetailsPanel } from "./view-card-details.ts";
import type { WorkboardProps } from "./view-helpers.ts";

function request(
  overrides: Partial<WorkboardResultReviewRequest> = {},
): WorkboardResultReviewRequest {
  return {
    schemaVersion: 1,
    id: "review-1",
    requestRevision: "a".repeat(64),
    resultDigest: "b".repeat(64),
    completionIntent: "c".repeat(64),
    revision: 1,
    status: "pending",
    tenant: "",
    boardId: "default",
    cardId: "card-1",
    sessionKey: "agent:main:result",
    runId: "run-1",
    createdAt: 2,
    expiresAt: null,
    result: { summary: "Fictional report ready for review", proof: [], artifacts: [] },
    resolvedAt: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(handler: (method: string, params: unknown) => unknown) {
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  state.cards = [
    createWorkboardCard({ status: "review", sessionKey: "agent:main:result", runId: "run-1" }),
  ];
  state.detailCardId = "card-1";
  const client = createWorkboardTestClient(handler);
  const container = document.createElement("div");
  document.body.append(container);
  const props: WorkboardProps = {
    host,
    client,
    connected: true,
    canWrite: true,
    agentsList: null,
    sessions: [],
    onOpenSession: vi.fn(),
  };
  const update = () => render(renderCardDetailsPanel(props), container);
  props.onRequestUpdate = update;
  workboardTestHost().connection.connected = true;
  update();
  onTestFinished(() => {
    render(nothing, container);
    container.remove();
  });
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === label,
    );
  return { state, props, client, container, update, button };
}

describe("native card result review", () => {
  it("renders explicit frozen results and resolves one exact request without dispatch or draft changes", async () => {
    const pending = deferred<{
      request: WorkboardResultReviewRequest;
      card: ReturnType<typeof createWorkboardCard>;
    }>();
    const f = fixture((method) =>
      method === "workboard.resultReviews.list" ? { requests: [request()] } : pending.promise,
    );
    f.state.detailCommentBody = "Keep this fictional note draft";
    f.state.detailCommentDrafts.set("card-1", f.state.detailCommentBody);
    f.update();
    await waitForFast(() => expect(f.button("Mark reviewed")).toBeDefined());
    const comment = f.container.querySelector<HTMLTextAreaElement>("textarea")!;
    comment.focus();
    f.button("Mark reviewed")!.click();
    f.button("Mark reviewed")!.click();
    expect(
      f.client.request.mock.calls.filter(
        ([method]) => method === "workboard.resultReviews.resolve",
      ),
    ).toEqual([
      [
        "workboard.resultReviews.resolve",
        {
          tenant: "",
          boardId: "default",
          cardId: "card-1",
          requestId: "review-1",
          expectedRevision: 1,
          expectedUpdatedAt: 1,
          decision: "reviewed",
        },
      ],
    ]);
    expect(document.activeElement).toBe(comment);
    pending.resolve({
      request: request({ status: "reviewed", revision: 2, resolvedAt: 3 }),
      card: createWorkboardCard({
        status: "done",
        updatedAt: 3,
        sessionKey: "agent:main:result",
        runId: "run-1",
      }),
    });
    await waitForFast(() => expect(f.state.cards[0]!.status).toBe("done"));
    expect(document.activeElement).toBe(comment);
    expect(f.state.detailCommentBody).toBe("Keep this fictional note draft");
    expect(f.state.detailCardId).toBe("card-1");
    expect(f.props.onOpenSession).not.toHaveBeenCalled();
    expect(
      f.client.request.mock.calls.every(([method]) =>
        method.startsWith("workboard.resultReviews."),
      ),
    ).toBe(true);
  });

  it("withdraws an explicit request without starting work", async () => {
    const f = fixture((method) =>
      method.endsWith("list")
        ? { requests: [request()] }
        : {
            request: request({ status: "withdrawn", revision: 2, resolvedAt: 3 }),
            card: createWorkboardCard({ status: "review", updatedAt: 3 }),
          },
    );
    await waitForFast(() => expect(f.button("Withdraw review request")).toBeDefined());
    f.button("Withdraw review request")!.click();
    await waitForFast(() => expect(f.state.cards[0]!.updatedAt).toBe(3));
    expect(f.state.cards[0]!.status).toBe("review");
    expect(f.client.request.mock.calls[1]![1]).toMatchObject({ decision: "withdrawn" });
  });

  it("does not invent a review request from Review, proof, or completed run status", async () => {
    const f = fixture(() => ({ requests: [] }));
    await Promise.resolve();
    expect(f.container.querySelector(".workboard-detail__result-review")).toBeNull();
    expect(f.client.request).toHaveBeenCalledTimes(1);
  });

  it("rejects a request from another tenant or card", async () => {
    const f = fixture(() => ({ requests: [request({ tenant: "other" })] }));
    await waitForFast(() =>
      expect(f.container.textContent).toContain("Result review requests are unavailable"),
    );
    expect(f.button("Mark reviewed")).toBeUndefined();
  });

  it("does not populate a new card with a late old-card list", async () => {
    const old = deferred<{ requests: WorkboardResultReviewRequest[] }>();
    const f = fixture((_, params) =>
      (params as { cardId: string }).cardId === "card-1" ? old.promise : { requests: [] },
    );
    f.state.cards.push(createWorkboardCard({ id: "card-2" }));
    f.state.detailCardId = "card-2";
    f.update();
    old.resolve({ requests: [request()] });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.button("Mark reviewed")).toBeUndefined();
    expect(f.state.detailCardId).toBe("card-2");
  });

  it("refuses a retained control after permission loss", async () => {
    const f = fixture(() => ({ requests: [request()] }));
    await waitForFast(() => expect(f.button("Mark reviewed")).toBeDefined());
    f.props.canWrite = false;
    f.button("Mark reviewed")!.click();
    expect(f.client.request).toHaveBeenCalledTimes(1);
  });

  it("does not publish an old resolution after the card changed", async () => {
    const pending = deferred<{
      request: WorkboardResultReviewRequest;
      card: ReturnType<typeof createWorkboardCard>;
    }>();
    const f = fixture((method) =>
      method.endsWith("list") ? { requests: [request()] } : pending.promise,
    );
    await waitForFast(() => expect(f.button("Mark reviewed")).toBeDefined());
    f.button("Mark reviewed")!.click();
    f.state.cards = [createWorkboardCard({ status: "blocked", updatedAt: 5 })];
    f.update();
    pending.resolve({
      request: request({ status: "reviewed", revision: 2, resolvedAt: 3 }),
      card: createWorkboardCard({
        status: "done",
        updatedAt: 3,
        sessionKey: "agent:main:result",
        runId: "run-1",
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.state.cards[0]!.status).toBe("blocked");
    expect(f.state.cards[0]!.updatedAt).toBe(5);
  });

  it("hides late results after unmount", async () => {
    const pending = deferred<{ requests: WorkboardResultReviewRequest[] }>();
    const f = fixture(() => pending.promise);
    render(nothing, f.container);
    pending.resolve({ requests: [request()] });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.container.textContent).toBe("");
  });

  it("reconnects with a fresh read and cannot revive a terminal request from an old response", async () => {
    const old = deferred<{ requests: WorkboardResultReviewRequest[] }>();
    let reads = 0;
    const f = fixture(() =>
      ++reads === 1
        ? old.promise
        : {
            requests: [request({ status: "reviewed", revision: 2, resolvedAt: 3 })],
          },
    );
    f.props.connected = false;
    f.update();
    f.props.connected = true;
    f.update();
    await waitForFast(() => expect(f.container.textContent).toContain("Result reviewed."));
    old.resolve({ requests: [request()] });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.button("Mark reviewed")).toBeUndefined();
    expect(f.container.textContent).toContain("Result reviewed.");
    expect(reads).toBe(2);
  });

  it("renders the frozen proof rather than newer card evidence", async () => {
    const f = fixture(() => ({
      requests: [
        request({
          result: {
            summary: "Fictional immutable report",
            artifacts: [],
            proof: [
              { id: "proof-1", createdAt: 2, status: "passed", label: "Frozen report check" },
            ],
          },
        }),
      ],
    }));
    f.state.cards[0]!.metadata = {
      proof: [{ id: "proof-new", createdAt: 3, status: "passed", label: "Later unrelated check" }],
    };
    f.update();
    await waitForFast(() =>
      expect(f.container.querySelector(".workboard-detail__result-review")?.textContent).toContain(
        "Frozen report check",
      ),
    );
    expect(
      f.container.querySelector(".workboard-detail__result-review")?.textContent,
    ).not.toContain("Later unrelated check");
  });

  it("shows uncertain resolution honestly and reads native truth before another decision", async () => {
    let reads = 0;
    const f = fixture((method) => {
      if (method.endsWith("resolve")) {
        throw new Error("Fictional response loss");
      }
      return {
        requests: [
          ++reads === 1 ? request() : request({ status: "reviewed", revision: 2, resolvedAt: 3 }),
        ],
      };
    });
    await waitForFast(() => expect(f.button("Mark reviewed")).toBeDefined());
    f.button("Mark reviewed")!.click();
    await waitForFast(() => expect(f.container.textContent).toContain("could not be confirmed"));
    expect(f.button("Mark reviewed")).toBeUndefined();
    f.button("Retry")!.click();
    await waitForFast(() => expect(f.container.textContent).toContain("Result reviewed."));
    expect(
      f.client.request.mock.calls.filter(([method]) => method.endsWith("resolve")),
    ).toHaveLength(1);
  });
  it("keeps an older run's proof visible but disables marking a different run reviewed", async () => {
    const f = fixture(() => ({ requests: [request()] }));
    f.state.cards[0]! = { ...f.state.cards[0]!, runId: "later-run" };
    f.update();
    await waitForFast(() => expect(f.button("Mark reviewed")).toBeDefined());
    expect(f.button("Mark reviewed")?.disabled).toBe(true);
    expect(f.button("Withdraw review request")?.disabled).toBe(false);
    f.button("Mark reviewed")!.click();
    expect(
      f.client.request.mock.calls.filter(([method]) => method.endsWith("resolve")),
    ).toHaveLength(0);
  });
});
