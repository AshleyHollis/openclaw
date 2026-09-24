// Workboard runtime metadata tests cover dispatcher persistence behavior.
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createMemoryStore } from "./dispatcher.test-support.js";
import { WorkboardStore } from "./store.js";

describe("dispatchAndStartWorkboardCards runtime metadata", () => {
  it("persists the resolved subagent runtime on new executions", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Claude worker",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({
      runId: "run-claude",
      runtime: {
        harness: "claude-cli",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      execution: {
        id: `${card.id}:agent-session`,
        engine: "claude-cli",
        model: "anthropic/claude-sonnet-4-6",
        runId: "run-claude",
      },
    });
  });

  it("omits unresolved runtime metadata instead of labeling it codex", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Unknown runtime worker",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-unknown" }) },
      options: { now: 10, maxStarts: 1 },
    });

    const execution = (await store.get(card.id))?.execution;
    expect(execution).toMatchObject({
      id: `${card.id}:agent-session`,
      runId: "run-unknown",
    });
    expect(execution).not.toHaveProperty("engine");
    expect(execution).not.toHaveProperty("model");
  });
});
