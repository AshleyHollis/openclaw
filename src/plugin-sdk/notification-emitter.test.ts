import { expectTypeOf, it } from "vitest";
import type * as Core from "./core.js";
import type * as Entry from "./plugin-entry.js";

// Both public entry sources must retain the exact closed type contract. Runtime
// execution alone is not this evidence: run the owning test typecheck as well.
it("exports the same notification types through both public SDK entry sources", () => {
  expectTypeOf<Core.PluginNotificationDeclarationV1>().toEqualTypeOf<Entry.PluginNotificationDeclarationV1>();
  expectTypeOf<Core.PluginNotificationCandidateV1>().toEqualTypeOf<Entry.PluginNotificationCandidateV1>();
  expectTypeOf<Core.PluginNotificationClearV1>().toEqualTypeOf<Entry.PluginNotificationClearV1>();
  expectTypeOf<Core.PluginNotificationEmitResult>().toEqualTypeOf<Entry.PluginNotificationEmitResult>();
  expectTypeOf<Core.PluginNotificationClearResult>().toEqualTypeOf<Entry.PluginNotificationClearResult>();
  expectTypeOf<Core.PluginNotificationEmitter>().toEqualTypeOf<Entry.PluginNotificationEmitter>();
  expectTypeOf<Core.PluginNotificationBinding>().toEqualTypeOf<Entry.PluginNotificationBinding>();
});
