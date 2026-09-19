import { describe, expect, it } from "vitest";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { projectConversationAttention } from "./chat-pane-attention.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

const identity = {
  agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
  hello: undefined,
} as unknown as Pick<ChatPageHost, "agentsList" | "hello">;

function question(id: string, sessionKey: string, agentId = "main"): QuestionPrompt {
  return {
    id,
    sessionKey,
    agentId,
    questions: [],
    createdAtMs: 1,
    expiresAtMs: 2,
    status: "pending",
    answeredElsewhere: false,
    localResolutionConfirmed: false,
    locallyExpired: false,
    submitting: false,
    error: null,
    drafts: new Map(),
    revision: 1,
  };
}

function approval(id: string, sessionKey: string, agentId = "main"): ExecApprovalRequest {
  return {
    id,
    kind: "exec",
    request: { command: `echo ${id}`, sessionKey, agentId },
    createdAtMs: 1,
    expiresAtMs: 2,
  };
}

describe("conversation Attention projection", () => {
  it("shows only questions and approvals owned by the selected conversation", () => {
    const result = projectConversationAttention(
      identity,
      "agent:main:alpha",
      "main",
      [
        question("alpha-question", "agent:main:alpha"),
        question("beta-question", "agent:main:beta"),
      ],
      [
        approval("beta-approval", "agent:main:beta"),
        approval("alpha-approval", "agent:main:alpha"),
      ],
    );
    expect(result.questions.map((entry) => entry.id)).toEqual(["alpha-question"]);
    expect(result.approval?.id).toBe("alpha-approval");
  });

  it("does not leak an unqualified global request across agent owners", () => {
    const result = projectConversationAttention(
      identity,
      "global",
      "research",
      [
        question("main-question", "global", "main"),
        question("research-question", "global", "research"),
      ],
      [
        approval("main-approval", "global", "main"),
        approval("research-approval", "global", "research"),
      ],
    );
    expect(result.questions.map((entry) => entry.id)).toEqual(["research-question"]);
    expect(result.approval?.id).toBe("research-approval");
  });

  it("reuses the scoped question projection until the owner queue changes", () => {
    const prompts = [question("alpha-question", "agent:main:alpha")];
    const first = projectConversationAttention(identity, "agent:main:alpha", "main", prompts, []);
    const second = projectConversationAttention(identity, "agent:main:alpha", "main", prompts, []);
    expect(second.questions).toBe(first.questions);
  });
});
