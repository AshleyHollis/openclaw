import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as lifecycleAdmission from "../../sessions/session-lifecycle-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import * as placementLifecycle from "../worker-environments/session-placement-lifecycle.js";
import * as chatAbortRuntime from "./chat-abort-runtime.js";
import { prepareSessionLifecycleDrain } from "./sessions-lifecycle-drain.js";

describe("session lifecycle cancellation admission", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["fresh-check-refusal", "authority-revoked"] as const)(
    "does not select or cancel work after %s across awaited preparation",
    async (failureMode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const entered = createDeferred();
        const checked = createDeferred();
        // The old fire-and-forget callback must not create an unhandled rejection
        // in the regression itself; its exact refusal remains the asserted result.
        void checked.promise.catch(() => {});
        const refusal = new Error("fresh empty-history check refused deletion");
        const revoked = new Error("deletion authority was revoked during preparation");
        let current = true;
        const authorize = vi.fn(() => {
          if (!current) {
            throw revoked;
          }
        });
        const selectCancellation = vi
          .spyOn(placementLifecycle, "prepareSessionWorkerPlacementStop")
          .mockImplementation(() => {
            throw new Error("Cancellation owner selected before admission completed");
          });
        const closeAdmissions = vi.spyOn(lifecycleAdmission, "closeSessionWorkAdmissions");
        const cancelChat = vi.spyOn(chatAbortRuntime, "abortChatRunsForSessionKeyWithPartials");
        const sessionKey = `agent:main:before-cancel-${failureMode}`;
        const preparing = prepareSessionLifecycleDrain({
          action: "delete",
          authorize,
          beforeCancel: () => {
            entered.resolve();
            return checked.promise;
          },
          context: createGatewayRequestContext(makeContextParams()),
          storePath: state.statePath("sessions.sqlite"),
          sessionKeys: [sessionKey],
          sessionKey,
          sessionId: `before-cancel-${failureMode}`,
          agentId: "main",
          lifecycleIdentities: [sessionKey],
        });
        const outcome = preparing.then(
          (drain) => {
            drain.release();
            return undefined;
          },
          (error: unknown) => error,
        );
        try {
          await entered.promise;
          expect(authorize).toHaveBeenCalledOnce();
          expect(selectCancellation).not.toHaveBeenCalled();
          expect(closeAdmissions).not.toHaveBeenCalled();
          expect(cancelChat).not.toHaveBeenCalled();
          if (failureMode === "fresh-check-refusal") {
            checked.reject(refusal);
          } else {
            current = false;
            checked.resolve();
          }
          expect(await outcome).toBe(failureMode === "fresh-check-refusal" ? refusal : revoked);
          expect(authorize).toHaveBeenCalledTimes(failureMode === "fresh-check-refusal" ? 1 : 2);
          expect(selectCancellation).not.toHaveBeenCalled();
          expect(closeAdmissions).not.toHaveBeenCalled();
          expect(cancelChat).not.toHaveBeenCalled();
        } finally {
          checked.resolve();
          await outcome;
        }
      });
    },
  );
});
