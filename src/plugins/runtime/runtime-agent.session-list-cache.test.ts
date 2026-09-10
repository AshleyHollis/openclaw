import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { respondWithCachedSessionList } from "../../gateway/server-methods/sessions-list-cache.js";
import { listSessionsFromStoreAsync } from "../../gateway/session-utils-list.js";
import type { SessionsListResult } from "../../gateway/session-utils.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";

it("refreshes the native roster after a committed plugin category patch", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const runtime = createRuntimeAgent();
    const scope = { agentId: "main", sessionKey: "agent:main:fixture-group" };
    const config: OpenClawConfig = {};
    const context = createDirectChatContext({ getRuntimeConfig: () => config });
    await runtime.session.upsertSessionEntry({
      ...scope,
      entry: { sessionId: "fixture", updatedAt: 100 },
    });
    let reads = 0;
    const list = async () => {
      let response: SessionsListResult | undefined;
      await respondWithCachedSessionList({
        client: null,
        config,
        context,
        request: { archived: "all", limit: 100 },
        respond: (ok, payload) => {
          expect(ok).toBe(true);
          response = payload as SessionsListResult;
        },
        run: async () => {
          reads++;
          const entry = runtime.session.getSessionEntry(scope);
          if (!entry) {
            throw new Error("Missing fixture Session");
          }
          return await listSessionsFromStoreAsync({
            cfg: config,
            storePath: "",
            store: { [scope.sessionKey]: entry },
            opts: { archived: "all", limit: 100 },
          });
        },
      });
      return response;
    };
    const first = await list();
    expect(first?.sessions[0]?.category).toBeUndefined();
    expect(await list()).toBe(first);
    expect(reads).toBe(1);
    await runtime.session.patchSessionEntry({
      ...scope,
      preserveActivity: true,
      update: () => ({ category: "Sample Project" }),
    });
    expect(runtime.session.getSessionEntry(scope)).toMatchObject({
      category: "Sample Project",
      updatedAt: 100,
    });
    const next = await list();
    expect(next?.sessions[0]?.category).toBe("Sample Project");
    expect(reads).toBe(2);
    await expect(
      runtime.session.patchSessionEntry({
        ...scope,
        preserveActivity: true,
        update: () => ({ category: "Refused" }),
        assertCommitAllowed: () => {
          throw new Error("Owner retired");
        },
      }),
    ).rejects.toThrow("Owner retired");
    expect(await list()).toBe(next);
    expect(reads).toBe(2);
    await runtime.session.patchSessionEntry({
      ...scope,
      preserveActivity: true,
      update: () => null,
    });
    expect(await list()).toBe(next);
    await runtime.session.patchSessionEntry({
      ...scope,
      preserveActivity: true,
      update: () => ({ category: undefined }),
    });
    expect((await list())?.sessions[0]?.category).toBeUndefined();
    expect(reads).toBe(3);
  });
});
