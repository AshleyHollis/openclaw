import { describe, expectTypeOf, it } from "vitest";
import type {
  PluginNotificationCandidateV1 as CorePluginNotificationCandidateV1,
  PluginNotificationDeclarationV1 as CorePluginNotificationDeclarationV1,
  PluginNotificationEmitter as CorePluginNotificationEmitter,
} from "./core.js";
import type {
  PluginNotificationCandidateV1,
  PluginNotificationClearResult,
  PluginNotificationClearV1,
  PluginNotificationDeclarationV1,
  PluginNotificationEmitResult,
  PluginNotificationEmitter,
} from "./plugin-entry.js";

describe("plugin-entry notification contract", () => {
  it("exposes only bounded candidate and host-mediated emitter types", () => {
    expectTypeOf<PluginNotificationDeclarationV1>().toEqualTypeOf<{
      version: 1;
      id: string;
      requiredScopes: (
        | "operator.admin"
        | "operator.approvals"
        | "operator.pairing"
        | "operator.questions"
        | "operator.read"
        | "operator.talk"
        | "operator.talk.secrets"
        | "operator.write"
      )[];
      destinations: { id: string; tabId: string }[];
    }>();
    expectTypeOf<PluginNotificationCandidateV1>().toEqualTypeOf<{
      version: 1;
      emissionId: string;
      logicalOperationId: string;
      attentionClass: "active" | "time-sensitive";
      preview: { title: string; body: string };
      deepLink: { kind: "plugin-detail"; destinationId: string; recordId: string };
      expiresAtMs: number;
    }>();
    expectTypeOf<PluginNotificationClearV1>().toEqualTypeOf<{
      version: 1;
      logicalOperationId: string;
    }>();
    expectTypeOf<PluginNotificationEmitResult>().toEqualTypeOf<{
      status:
        | "sent"
        | "partial"
        | "suppressed"
        | "expired"
        | "rate-limited"
        | "no-targets"
        | "failed"
        | "ambiguous";
      attempted: number;
      delivered: number;
      failed: number;
      ambiguous: number;
      retryAfterMs?: number;
    }>();
    expectTypeOf<PluginNotificationClearResult>().toEqualTypeOf<{
      status: "cleared" | "already-cleared" | "partial" | "ambiguous";
      attempted: number;
      cleared: number;
      failed: number;
      ambiguous: number;
    }>();
    expectTypeOf<PluginNotificationEmitter>().toEqualTypeOf<{
      bindCurrentOperator():
        | {
            emit(candidate: PluginNotificationCandidateV1): Promise<PluginNotificationEmitResult>;
            clear(request: PluginNotificationClearV1): Promise<PluginNotificationClearResult>;
          }
        | undefined;
    }>();
    expectTypeOf<CorePluginNotificationCandidateV1>().toEqualTypeOf<PluginNotificationCandidateV1>();
    expectTypeOf<CorePluginNotificationDeclarationV1>().toEqualTypeOf<PluginNotificationDeclarationV1>();
    expectTypeOf<CorePluginNotificationEmitter>().toEqualTypeOf<PluginNotificationEmitter>();
  });
});
