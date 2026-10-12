import { expect, it } from "vitest";
import { applyAgentAutoCompactionGuard } from "../agent-settings.js";
import { projectSettledTurnFinalizationAttemptResult } from "../harness/settled-turn-finalization-result.js";
import { makeEmbeddedRunnerAttempt } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import {
  createCompactionHandlers,
  createResourceLoader,
} from "./agent-session-loop-resource-loader.test-support.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

it.each([true, false])(
  "protects a finalizer at the context threshold while ordinary attempts still compact (finalizer=%s)",
  async (compactionForbidden) => {
    const model = { ...testModel, contextWindow: 4_096, maxTokens: 256 };
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "Earlier request", timestamp: 1 });
    sessionManager.appendMessage(
      createAssistant(model, [{ type: "text", text: "Earlier answer" }], "stop", 3_100),
    );
    applyAgentAutoCompactionGuard({ settingsManager, compactionForbidden });
    const { session } = await createTestSession({
      model,
      settingsManager,
      sessionManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
      contextOverflowRecoveryOwner: "caller",
    });
    const summary = "The completed tool saved the note once.";
    streamMocks.streamSimple.mockImplementation(() =>
      createAssistantResultStream(createAssistant(model, [{ type: "text", text: summary }])),
    );

    await session.prompt("Summarize the settled tool results without repeating any actions.");

    const compactions = sessionManager.getEntries().filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(compactionForbidden ? 0 : 1);
    const assistant = session.messages.at(-1);
    if (assistant?.role !== "assistant") {
      throw new Error("Expected the scripted finalizer assistant");
    }
    const attempt = makeEmbeddedRunnerAttempt({
      compactionCount: compactions.length,
      currentAttemptCompletedAssistant: assistant,
    });
    if (compactionForbidden) {
      expect(projectSettledTurnFinalizationAttemptResult(attempt).assistant.content).toEqual([
        { type: "text", text: summary },
      ]);
    } else {
      expect(() => projectSettledTurnFinalizationAttemptResult(attempt)).toThrow(
        "Settled-turn finalization attempt did not complete successfully",
      );
    }
  },
);
