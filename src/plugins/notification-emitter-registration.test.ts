import { afterEach, describe, expect, it } from "vitest";
import { buildPluginApi, createUnavailableRuntime } from "./api-builder.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import type { PluginNotificationDeclarationV1 } from "./notification-emitter.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

afterEach(() => resetPluginRuntimeStateForTest());
describe("native notification registration", () => {
  it("closes a captured nested registration method when register returns", () => {
    let calls = 0;
    const api = buildPluginApi({
      id: "example",
      name: "Example",
      source: "test",
      registrationMode: "full",
      config: {},
      runtime: createUnavailableRuntime("setup-only"),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      resolvePath: (value) => value,
      notifications: {
        registerEmitter: () => {
          calls++;
          return undefined;
        },
      },
    });
    let captured: typeof api.notifications.registerEmitter | undefined;
    const declaration: PluginNotificationDeclarationV1 = {
      version: 1,
      id: "attention",
      requiredScopes: ["operator.read"],
      destinations: [{ id: "item", pageId: "attention" }],
    };
    runPluginRegisterSyncInRegistry(
      (guarded) => {
        captured = guarded.notifications.registerEmitter;
        captured(declaration);
      },
      api,
      createEmptyPluginRegistry(),
      "example",
    );
    captured?.(declaration);
    expect(calls).toBe(1);
  });
  it("registers a closed owned page declaration without manufacturing operator authority", () => {
    const registry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createUnavailableRuntime("setup-only"),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: "example",
      source: "/plugins/example/index.ts",
      origin: "global",
      enabled: true,
      configSchema: false,
      controlUi: { entry: "dist/control-ui/index.js" },
    });
    const api = registry.createApi(record, { config: {} });
    const declaration: PluginNotificationDeclarationV1 = {
      version: 1,
      id: "attention",
      requiredScopes: ["operator.read"],
      destinations: [{ id: "item", pageId: "attention" }],
    };
    const emitter = api.notifications.registerEmitter(declaration);
    expect(emitter).toBeDefined();
    declaration.destinations[0]!.pageId = "mutated";
    expect(registry.registry.notificationEmitters[0]?.declaration.destinations[0]?.pageId).toBe(
      "attention",
    );
    expect(api.notifications.registerEmitter(declaration)).toBeUndefined();
    registry.registry.plugins.push(record);
    setActivePluginRegistry(registry.registry);
    expect(emitter?.bindCurrentOperator()).toBeUndefined();
    expect(
      api.notifications.registerEmitter({
        ...declaration,
        id: "url-injection",
        destinations: [{ id: "item", pageId: "https://outside.example" }],
      }),
    ).toBeUndefined();
    expect(registry.registry.notificationEmitters).toHaveLength(1);
  });
});
