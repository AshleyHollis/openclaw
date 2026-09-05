// Control UI registry tests cover compatibility for plugin-declared descriptors.
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";
import { createPluginRecord } from "./status.test-fixtures.js";

describe("plugin registry Control UI descriptors", () => {
  it("keeps legacy flat descriptors loadable for shipped JavaScript plugins", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "legacy-descriptor-fixture",
        name: "Legacy Descriptor Fixture",
      }),
      register(api) {
        api.registerControlUiDescriptor({
          id: "legacy-card",
          name: "Legacy Card",
          description: "Legacy descriptor from a JavaScript plugin",
        } as never);
      },
    });

    expect(registry.registry.controlUiDescriptors).toEqual([
      expect.objectContaining({
        pluginId: "legacy-descriptor-fixture",
        descriptor: expect.objectContaining({
          id: "legacy-card",
          surface: "session",
          label: "Legacy Card",
        }),
      }),
    ]);
  });

  it("accepts a bundled plugin's matching native route placement", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "workboard", name: "Workboard", origin: "bundled" }),
      register(api) {
        api.registerControlUiDescriptor({
          surface: "tab",
          id: "workboard",
          label: "Workboard",
          placement: "route:workboard",
          icon: "kanban",
          group: "control",
          order: 5,
          requiredScopes: ["operator.read"],
        });
      },
    });

    expect(registry.registry.controlUiDescriptors).toEqual([
      expect.objectContaining({
        pluginId: "workboard",
        descriptor: expect.objectContaining({
          id: "workboard",
          surface: "tab",
          label: "Workboard",
          placement: "route:workboard",
          icon: "kanban",
          group: "control",
          order: 5,
          requiredScopes: ["operator.read"],
        }),
      }),
    ]);
  });

  it.each([
    { id: "workboard", origin: "workspace" as const },
    { id: "logbook", origin: "bundled" as const },
  ])("rejects unowned native route placement from $origin plugin $id", ({ id, origin }) => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id, origin }),
      register(api) {
        api.registerControlUiDescriptor({
          surface: "tab",
          id: "panel",
          label: "Panel",
          placement: "route:workboard",
        });
      },
    });

    expect(registry.registry.controlUiDescriptors).toEqual([]);
    expect(registry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: id,
        message: expect.stringContaining("must be owned by its bundled plugin"),
      }),
    );
  });

  it("captures up to eight notification declarations before validating their eventual tab ownership", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "notification-fixture", name: "Notification Fixture" }),
      register(api) {
        const declaration = {
          version: 1 as const,
          id: "ready",
          requiredScopes: ["operator.read" as const],
          destinations: [{ id: "item", tabId: "board" }],
        };
        expect(api.notifications.registerEmitter(declaration)).toBeDefined();
        // The registry owns a structural copy, not this plugin-controlled object.
        declaration.destinations[0]!.tabId = "foreign";
        for (let index = 1; index < 8; index += 1) {
          expect(
            api.notifications.registerEmitter({
              version: 1,
              id: `ready-${index}`,
              requiredScopes: ["operator.read"],
              destinations: [{ id: `item-${index}`, tabId: "board" }],
            }),
          ).toBeDefined();
        }
        expect(
          api.notifications.registerEmitter({
            version: 1,
            id: "too-many",
            requiredScopes: ["operator.read"],
            destinations: [{ id: "overflow", tabId: "board" }],
          }),
        ).toBeUndefined();
        // Destination registration intentionally follows declaration registration.
        api.registerControlUiDescriptor({ surface: "tab", id: "board", label: "Board" });
      },
    });

    expect(registry.registry.notificationEmitters).toHaveLength(8);
    expect(registry.registry.notificationEmitters[0]).toMatchObject({
      pluginId: "notification-fixture",
      declaration: { destinations: [{ id: "item", tabId: "board" }] },
    });
  });

  it("keeps an authenticated tab when its optional capability bridge is incompatible", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "tab-fixture", name: "Tab Fixture" }),
      register(api) {
        api.registerControlUiDescriptor({
          surface: "tab",
          id: "journal",
          label: "Journal",
          path: "/plugins/tab-fixture/journal",
          capabilityBridge: {
            protocolVersion: 2,
            requiredMethods: [],
            optionalMethods: [],
          },
        } as never);
      },
    });

    expect(registry.registry.controlUiDescriptors).toEqual([
      expect.objectContaining({
        pluginId: "tab-fixture",
        descriptor: expect.objectContaining({
          id: "journal",
          path: "/plugins/tab-fixture/journal",
        }),
      }),
    ]);
    expect(registry.registry.controlUiDescriptors[0]?.descriptor).not.toHaveProperty(
      "capabilityBridge",
    );
    expect(registry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("capabilityBridge is invalid and will be ignored"),
      }),
    );
  });

  it("accepts trusted dashboard widget descriptors", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "workboard", name: "Workboard" }),
      register(api) {
        api.session.controls.registerControlUiDescriptor({
          surface: "widget",
          id: "card",
          label: "Workboard card",
          requiredScopes: ["operator.read"],
        });
      },
    });

    expect(registry.registry.controlUiDescriptors).toEqual([
      expect.objectContaining({
        pluginId: "workboard",
        descriptor: expect.objectContaining({
          id: "card",
          surface: "widget",
          label: "Workboard card",
        }),
      }),
    ]);
  });

  it.each(["logbook.link.resolve", "undeclared.resolve", 12])(
    "validates and retains only a declared navigation resolver: %s",
    (resolver) => {
      const { config, registry } = createPluginRegistryFixture();
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({ id: "logbook" }),
        register(api) {
          api.session.controls.registerControlUiDescriptor({
            surface: "tab",
            id: "logbook",
            label: "Logbook",
            path: "/plugins/logbook",
            capabilityBridge: {
              protocolVersion: 1,
              requiredMethods: ["ui.session.navigateResolved"],
              optionalMethods: ["logbook.link.resolve"],
              sessionNavigationResolver: resolver,
            },
          } as never);
        },
      });
      const descriptor = registry.registry.controlUiDescriptors[0]?.descriptor;
      if (resolver === "logbook.link.resolve") {
        expect(descriptor?.capabilityBridge?.sessionNavigationResolver).toBe(resolver);
      } else {
        expect(descriptor).not.toHaveProperty("capabilityBridge");
      }
    },
  );

  it("rejects protocol-relative tab paths that would iframe external content", () => {
    for (const path of ["//attacker.example/panel", "/\\attacker.example/panel"]) {
      const { config, registry } = createPluginRegistryFixture();
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({ id: "external-tab", name: "External Tab" }),
        register(api) {
          api.registerControlUiDescriptor({
            surface: "tab",
            id: "journal",
            label: "Journal",
            path,
          });
        },
      });
      expect(registry.registry.controlUiDescriptors).toEqual([]);
      expect(registry.registry.diagnostics).toContainEqual(
        expect.objectContaining({ level: "error", pluginId: "external-tab" }),
      );
    }
  });

  it("rejects tab descriptors whose path is not absolute", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "bad-tab-fixture", name: "Bad Tab Fixture" }),
      register(api) {
        api.registerControlUiDescriptor({
          surface: "tab",
          id: "journal",
          label: "Journal",
          path: "relative/frame.html",
        });
      },
    });

    expect(registry.registry.controlUiDescriptors).toEqual([]);
    expect(registry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "bad-tab-fixture",
        message: expect.stringContaining("gateway-local absolute path"),
      }),
    );
  });
});
