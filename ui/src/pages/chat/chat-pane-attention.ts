import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { scopedSessionArtifactKey, uiConversationMatches } from "../../lib/sessions/session-key.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

const projectedQuestionCache = new WeakMap<
  readonly QuestionPrompt[],
  Map<string, readonly QuestionPrompt[]>
>();

/** Keep native questions and approvals at the conversation that owns them. */
export function projectConversationAttention(
  state: Pick<ChatPageHost, "agentsList" | "hello">,
  sessionKey: string,
  agentId: string,
  prompts: readonly QuestionPrompt[],
  approvals: readonly ExecApprovalRequest[],
) {
  const scope = `${sessionKey}\0${agentId}`;
  const selectedOwnerKey = scopedSessionArtifactKey(sessionKey, agentId);
  let scopedQuestions = projectedQuestionCache.get(prompts)?.get(scope);
  if (!scopedQuestions) {
    scopedQuestions = prompts.filter((prompt) =>
      uiConversationMatches(
        state,
        selectedOwnerKey,
        prompt.sessionKey
          ? scopedSessionArtifactKey(prompt.sessionKey, prompt.agentId)
          : prompt.sessionKey,
        prompt.agentId,
      ),
    );
    let entries = projectedQuestionCache.get(prompts);
    if (!entries) {
      entries = new Map();
      projectedQuestionCache.set(prompts, entries);
    }
    entries.set(scope, scopedQuestions);
  }
  return {
    questions: scopedQuestions,
    approval:
      approvals.find((entry) =>
        uiConversationMatches(
          state,
          selectedOwnerKey,
          entry.request.sessionKey
            ? scopedSessionArtifactKey(entry.request.sessionKey, entry.request.agentId ?? undefined)
            : entry.request.sessionKey,
          entry.request.agentId,
        ),
      ) ?? null,
  };
}
