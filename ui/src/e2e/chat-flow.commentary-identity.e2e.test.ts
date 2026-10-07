import path from "node:path";
import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each(["history-first", "delta-first"] as const)(
    "keeps producer-owned commentary once through %s and terminal cleanup",
    async (order) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const runId = "commentary-identity-run";
        const earlier = "An earlier observation remains visible.";
        const commentary = "The saved commentary should appear once.";
        const later = "The next identified item remains visible.";
        const startedAt = Date.now();
        const gateway = await installMockGateway(page, {
          historyMessages: [],
          agentModel: "synthetic/example-model",
          models: [{ id: "example-model", name: "Example model", provider: "synthetic" }],
          inFlightRun: { runId, startedAt, text: earlier },
          sessionInfo: {
            key: "agent:main:main",
            hasActiveRun: true,
            activeRunIds: [runId],
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByRole("button", { name: "Stop generating" }).waitFor();
        await gateway.deferNext("chat.history");
        const persist = () =>
          gateway.emitGatewayEvent("session.message", {
            sessionKey: "agent:main:main",
            runId,
            clientRunId: runId,
            hasActiveRun: true,
            activeRunIds: [runId],
            messageId: "saved-commentary",
            messageSeq: 1,
            message: {
              role: "assistant",
              content: [{ type: "text", text: commentary }],
              __openclaw: { id: "saved-commentary", runId, seq: 1 },
              openclawStreamFallback: { source: "segment", itemId: "commentary-1" },
            },
          });
        const delta = () =>
          gateway.emitGatewayEvent("chat", {
            sessionKey: "agent:main:main",
            runId,
            seq: 2,
            state: "delta",
            itemId: "commentary-1",
            itemStartOffset: `${earlier}\n\n`.length,
            message: {
              role: "assistant",
              content: [{ type: "text", text: `${earlier}\n\n${commentary}` }],
            },
          });
        if (order === "history-first") {
          await persist();
          await delta();
        } else {
          await delta();
          await persist();
        }
        await gateway.emitGatewayEvent("chat", {
          sessionKey: "agent:main:main",
          runId,
          seq: 3,
          state: "delta",
          itemId: "commentary-2",
          itemStartOffset: `${earlier}\n\n${commentary}\n\n`.length,
          message: {
            role: "assistant",
            content: [{ type: "text", text: `${earlier}\n\n${commentary}\n\n${later}` }],
          },
        });
        const texts = async () =>
          (await page.locator(".chat-text").allTextContents()).map((text) => text.trim());
        await expect.poll(texts).toEqual([earlier, commentary, later]);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, `${order}-active.png`),
          });
        }
        await gateway.emitGatewayEvent("chat", {
          sessionKey: "agent:main:main",
          runId,
          seq: 4,
          state: "aborted",
        });
        await page.getByRole("button", { name: "Stop generating" }).waitFor({ state: "hidden" });
        await expect.poll(texts).toEqual([earlier, commentary, later]);
      });
    },
  );
});
