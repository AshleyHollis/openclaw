import { describe, expect, it, vi } from "vitest";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import { createLinkedCard, execution, runSessionSweep } from "./lifecycle-sync.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("Workboard authoritative fallback settlement and result receipts", () => {
  it.each([false, true])(
    "preserves explicit result receipts after an active attempt success=%s",
    async (success) => {
      const store = createWorkboardSqliteTestStore();
      const sessionKey = "agent:main:subagent:workboard-result-fallback";
      const runId = "result-fallback-run";
      const card = await createLinkedCard(store, {
        sessionKey,
        runId,
        execution: execution(sessionKey, runId),
      });
      const readSessions = async () => ({
        sessions: [
          {
            key: sessionKey,
            status: "running" as const,
            hasActiveRun: true,
            updatedAt: card.updatedAt + 1,
          },
        ],
        complete: true,
      });
      await syncWorkboardAgentEnded({
        store,
        event: { runId, success },
        context: { sessionKey, runId },
        readSessions,
      });
      expect(await store.get(card.id)).toEqual(card);
      const scope = { tenant: "", boardId: "default", cardId: card.id };
      expect(await store.listResultReviews(scope, () => {})).toEqual([]);
      const input = {
        expectedUpdatedAt: card.updatedAt,
        resultReview: { logicalOperationId: "fallback-result-v1" },
        summary: "Completed fallback result",
        proof: { status: "passed", label: "Fallback result checks" },
      };
      const completed = await store.complete(card.id, input, null, () => {});
      const receipts = await store.listResultReviews(scope, () => {});
      expect(receipts).toHaveLength(1);
      const receipt = receipts[0]!;
      const retainedBytes = JSON.stringify(receipt);
      for (const status of ["done", "failed", "failed"] as const) {
        await runSessionSweep({
          store,
          sessions: [
            { key: sessionKey, status, hasActiveRun: false, updatedAt: completed.updatedAt + 1 },
          ],
        });
        expect(
          JSON.stringify(
            await store.getResultReview({ ...scope, requestId: receipt.id }, () => {}),
          ),
        ).toBe(retainedBytes);
        expect((await store.get(card.id))?.status).toBe("review");
      }
      const resolved = await store.resolveResultReview(
        {
          ...scope,
          requestId: receipt.id,
          expectedRevision: receipt.revision,
          expectedUpdatedAt: (await store.get(card.id))!.updatedAt,
          decision: "reviewed",
        },
        () => {},
      );
      const reviewedBytes = JSON.stringify(resolved.request);
      for (const context of [
        { sessionKey, runId: "older-run" },
        { sessionKey: "agent:other:subagent:workboard-result-fallback", runId },
      ]) {
        await syncWorkboardAgentEnded({
          store,
          event: { runId: context.runId, success: false },
          context,
          readSessions: async () => ({
            sessions: [
              {
                key: context.sessionKey,
                status: "failed",
                hasActiveRun: false,
                updatedAt: resolved.card.updatedAt + 1,
              },
            ],
            complete: true,
          }),
        });
      }
      await runSessionSweep({
        store,
        sessions: [
          {
            key: sessionKey,
            status: "failed",
            hasActiveRun: false,
            updatedAt: resolved.card.updatedAt + 2,
          },
        ],
      });
      expect((await store.get(card.id))?.status).toBe("done");
      expect(
        JSON.stringify(await store.getResultReview({ ...scope, requestId: receipt.id }, () => {})),
      ).toBe(reviewedBytes);
      expect(await store.complete(card.id, input, null, () => {})).toEqual(
        await store.get(card.id),
      );
    },
  );

  it.each([false, true])(
    "waits for fallback exhaustion after agent_end success=%s",
    async (success) => {
      const store = createWorkboardSqliteTestStore();
      const sessionKey = "agent:worker:subagent:workboard-ops-fallback-live";
      const card = await createLinkedCard(store, {
        sessionKey,
        runId: "run-agent",
        execution: execution(sessionKey, "run-agent"),
      });
      const readSessions = vi.fn().mockResolvedValue({
        sessions: [
          { key: sessionKey, status: "running", hasActiveRun: true, updatedAt: card.updatedAt + 1 },
        ],
        complete: true,
      });

      await syncWorkboardAgentEnded({
        store,
        event: { runId: "run-agent", success },
        context: { runId: "run-agent", sessionKey },
        now: card.updatedAt + 2,
        readSessions,
      });

      const vetoed = await store.get(card.id);
      expect(vetoed).toMatchObject({
        status: "running",
        execution: { status: "running" },
      });
      expect(vetoed?.metadata?.failureCount).toBeUndefined();
      expect(
        vetoed?.events?.some((event) => event.kind === "moved" && event.toStatus === "blocked"),
      ).toBe(false);

      await runSessionSweep({
        store,
        sessions: [
          {
            key: sessionKey,
            status: "failed",
            hasActiveRun: false,
            updatedAt: card.updatedAt + 3,
          },
        ],
        now: card.updatedAt + 3,
      });
      await expect(store.get(card.id)).resolves.toMatchObject({
        status: "blocked",
        execution: { status: "blocked" },
        metadata: { failureCount: 1 },
      });
      await runSessionSweep({
        store,
        sessions: [
          { key: sessionKey, status: "failed", hasActiveRun: false, updatedAt: card.updatedAt + 3 },
        ],
        now: card.updatedAt + 3,
      });
      await expect(store.get(card.id)).resolves.toMatchObject({
        status: "blocked",
        execution: { status: "blocked" },
        metadata: { failureCount: 1 },
      });
    },
  );

  it("still blocks immediately when agent_end fails after the run ended", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:worker:subagent:workboard-ops-terminal-failed";
    const card = await createLinkedCard(store, {
      sessionKey,
      runId: "run-agent",
      execution: execution(sessionKey, "run-agent"),
    });
    const readSessions = vi.fn().mockResolvedValue({
      sessions: [
        { key: sessionKey, status: "failed", hasActiveRun: false, updatedAt: card.updatedAt + 1 },
      ],
      complete: true,
    });

    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: false },
      context: { runId: "run-agent", sessionKey },
      now: card.updatedAt + 2,
      readSessions,
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      execution: { status: "blocked" },
      metadata: { failureCount: 1 },
    });
  });

  it("defers terminal settlement when the lifecycle snapshot is unavailable", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:worker:subagent:workboard-ops-read-failure";
    const card = await createLinkedCard(store, {
      sessionKey,
      runId: "run-agent",
      execution: execution(sessionKey, "run-agent"),
    });
    const readSessions = vi.fn().mockResolvedValue({ sessions: [], complete: false });

    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: false },
      context: { runId: "run-agent", sessionKey },
      now: card.updatedAt + 2,
      readSessions,
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      execution: { status: "running" },
    });
  });

  it("blocks on the event's exact terminal session while another agent runs the same suffix", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createLinkedCard(store, {
      sessionKey: "subagent:workboard-ops-card",
      runId: "run-agent",
      execution: execution("subagent:workboard-ops-card", "run-agent"),
    });
    const alphaKey = "agent:alpha:subagent:workboard-ops-card";
    const betaKey = "agent:beta:subagent:workboard-ops-card";
    const readSessions = vi.fn().mockResolvedValue({
      sessions: [
        { key: alphaKey, status: "failed", hasActiveRun: false, updatedAt: card.updatedAt + 1 },
        { key: betaKey, status: "running", hasActiveRun: true, updatedAt: card.updatedAt + 1 },
      ],
      complete: true,
    });

    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: false },
      context: { runId: "run-agent", sessionKey: alphaKey },
      now: card.updatedAt + 2,
      readSessions,
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      execution: { status: "blocked" },
      metadata: { failureCount: 1 },
    });
  });

  it("defers an attempt without an exact session key to the session sweep", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createLinkedCard(store, {
      sessionKey: "subagent:workboard-ops-ambiguous",
      runId: "run-agent",
      execution: execution("subagent:workboard-ops-ambiguous", "run-agent"),
    });
    const readSessions = vi.fn().mockResolvedValue({
      sessions: [
        {
          key: "agent:alpha:subagent:workboard-ops-ambiguous",
          status: "failed",
          hasActiveRun: false,
        },
        {
          key: "agent:beta:subagent:workboard-ops-ambiguous",
          status: "running",
          hasActiveRun: true,
        },
      ],
      complete: true,
    });

    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: false },
      context: { runId: "run-agent" },
      now: card.updatedAt + 2,
      readSessions,
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      execution: { status: "running" },
    });
  });
});
