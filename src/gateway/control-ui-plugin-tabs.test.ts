import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginControlUiDescriptor } from "../plugins/host-hooks.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  listControlUiCapabilityBridgeLinkedSessionKeys,
  listControlUiPluginTabAuthGrants,
  listControlUiPluginTabs,
  listControlUiPluginWidgetKinds,
} from "./control-ui-plugin-tabs.js";

const EXPECTED_MAX_LINKED_SESSION_KEYS = 200;

function tabDescriptor(
  overrides: Partial<PluginControlUiDescriptor> = {},
): PluginControlUiDescriptor {
  return {
    id: "logbook",
    surface: "tab",
    label: "Logbook",
    ...overrides,
  };
}

function activateDescriptors(
  entries: Array<{ pluginId: string; descriptor: PluginControlUiDescriptor }>,
  routes: Array<{
    pluginId: string;
    path: string;
    auth?: "gateway" | "plugin";
    match?: "exact" | "prefix";
  }> = [],
  methods: Array<{ pluginId: string; name: string; scope: "operator.read" | "operator.write" | "operator.admin" }> = [],
): void {
  const registry = createTestRegistry([]);
  registry.controlUiDescriptors = entries.map((entry) => ({
    ...entry,
    source: `test:${entry.pluginId}`,
  }));
  registry.httpRoutes = routes.map((route) => ({
    ...route,
    auth: route.auth ?? "gateway",
    match: route.match ?? "prefix",
    source: `test:${route.pluginId}`,
    handler: async () => true,
  }));
  registry.gatewayMethodDescriptors = methods.map((method) => ({
    name: method.name,
    handler: (() => undefined) as never,
    scope: method.scope,
    owner: { kind: "plugin", pluginId: method.pluginId },
    profileAccess: "independent",
  }));
  setActivePluginRegistry(registry);
}

describe("listControlUiPluginTabs", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("projects only tab descriptors", () => {
    activateDescriptors([
      {
        pluginId: "workboard",
        descriptor: tabDescriptor({ placement: "route:workboard" }),
      },
      { pluginId: "other", descriptor: tabDescriptor({ id: "run-panel", surface: "run" }) },
    ]);

    const tabs = listControlUiPluginTabs(["operator.admin"]);
    expect(tabs.map((tab) => tab.id)).toEqual(["logbook"]);
    expect(expectDefined(tabs[0], "tabs[0] test invariant")).toMatchObject({
      placement: "route:workboard",
      pluginId: "workboard",
    });
  });

  it("hides tabs whose required scopes are not granted", () => {
    activateDescriptors([
      {
        pluginId: "logbook",
        descriptor: tabDescriptor({ requiredScopes: ["operator.write"] }),
      },
      {
        pluginId: "adminy",
        descriptor: tabDescriptor({
          id: "adminy",
          label: "Admin",
          requiredScopes: ["operator.admin"],
        }),
      },
    ]);

    expect(listControlUiPluginTabs(["operator.read"])).toEqual([]);
    expect(listControlUiPluginTabs(["operator.write"]).map((tab) => tab.id)).toEqual(["logbook"]);
    expect(listControlUiPluginTabs(["operator.admin"]).map((tab) => tab.id)).toEqual([
      "adminy",
      "logbook",
    ]);
  });

  it("orders deterministically by order, label, then id", () => {
    activateDescriptors([
      { pluginId: "b", descriptor: tabDescriptor({ id: "beta", label: "Beta" }) },
      { pluginId: "a", descriptor: tabDescriptor({ id: "alpha", label: "Alpha", order: 5 }) },
      { pluginId: "c", descriptor: tabDescriptor({ id: "zed", label: "Beta" }) },
    ]);

    expect(listControlUiPluginTabs([]).map((tab) => tab.id)).toEqual(["beta", "zed", "alpha"]);
  });

  it("merges the read-scoped core kind into deterministic plugin ordering", () => {
    activateDescriptors([
      {
        pluginId: "workboard",
        descriptor: tabDescriptor({
          id: "card",
          surface: "widget",
          label: "Workboard card",
          requiredScopes: ["operator.read"],
        }),
      },
      {
        pluginId: "workboard",
        descriptor: tabDescriptor({
          id: "mini",
          surface: "widget",
          label: "Workboard summary",
          requiredScopes: ["operator.read"],
        }),
      },
    ]);

    expect(listControlUiPluginWidgetKinds([])).toEqual([]);
    expect(listControlUiPluginWidgetKinds(["operator.read"])).toEqual([
      { pluginId: "session", kind: "session:progress", label: "Session progress" },
      { pluginId: "workboard", kind: "workboard:card", label: "Workboard card" },
      { pluginId: "workboard", kind: "workboard:mini", label: "Workboard summary" },
    ]);
  });

  it("follows active-registry swaps without retaining stale descriptors", () => {
    const gatewayRegistry = createTestRegistry([]);
    gatewayRegistry.controlUiDescriptors = [
      {
        pluginId: "workboard",
        descriptor: tabDescriptor({
          id: "card",
          surface: "widget",
          label: "Workboard card",
          requiredScopes: ["operator.read"],
        }),
        source: "test:workboard",
      },
      { pluginId: "logbook", descriptor: tabDescriptor(), source: "test:logbook" },
    ];
    setActivePluginRegistry(gatewayRegistry);

    expect(listControlUiPluginWidgetKinds(["operator.read"]).map((kind) => kind.kind)).toEqual([
      "session:progress",
      "workboard:card",
    ]);
    expect(listControlUiPluginTabs(["operator.admin"]).map((tab) => tab.id)).toEqual(["logbook"]);

    // The current runtime has one active registry rather than pinned per-surface
    // compatibility registries, so swaps must not retain stale tab authorities.
    setActivePluginRegistry(createTestRegistry([]));

    expect(listControlUiPluginWidgetKinds(["operator.read"])).toEqual([
      { pluginId: "session", kind: "session:progress", label: "Session progress" },
    ]);
    expect(listControlUiPluginTabs(["operator.admin"])).toEqual([]);
  });

  it("derives bounded linked-session inputs from durable plugin ownership", () => {
    const entries = [
      ["agent:main:foreign", { pluginOwnerId: "other" }],
      ["agent:main:pending", { pluginOwnerId: "logbook", initializationPending: true }],
      ["agent:main:b", { pluginOwnerId: "logbook" }],
      ["agent:main:a", { pluginOwnerId: "logbook" }],
      ...Array.from(
        { length: EXPECTED_MAX_LINKED_SESSION_KEYS + 2 },
        (_, i) => [`agent:bulk:${String(i).padStart(3, "0")}`, { pluginOwnerId: "bulk" }] as const,
      ),
    ] as const;

    const links = listControlUiCapabilityBridgeLinkedSessionKeys(entries);
    expect(links.get("logbook")).toEqual(["agent:main:a", "agent:main:b"]);
    expect(links.get("other")).toEqual(["agent:main:foreign"]);
    expect(links.get("bulk")).toHaveLength(EXPECTED_MAX_LINKED_SESSION_KEYS);
    expect(links.get("bulk")?.at(0)).toBe("agent:bulk:000");
    expect(links.get("bulk")?.at(-1)).toBe("agent:bulk:199");
  });

  it("includes only the authenticated host-provided links in a capability grant", () => {
    activateDescriptors(
      [
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({
            path: "/plugins/logbook/panel",
            capabilityBridge: {
              protocolVersion: 1,
              requiredMethods: ["chat.history"],
              optionalMethods: ["chat.send"],
            },
          }),
        },
      ],
      [{ pluginId: "logbook", path: "/plugins/logbook", match: "prefix" }],
    );

    const [tab] = listControlUiPluginTabs(["operator.admin"], {
      availableMethods: ["chat.history", "chat.send"],
      linkedSessionKeysByPlugin: new Map([
        ["logbook", ["agent:main:owned"]],
        ["other", ["agent:main:foreign"]],
      ]),
    });

    expect(tab?.capabilityBridge).toMatchObject({
      methods: ["chat.history", "chat.send"],
      linkedSessionKeys: ["agent:main:owned"],
    });
  });

  it("falls back to declared reads when the operator cannot receive a required write", () => {
    activateDescriptors(
      [
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({
            path: "/plugins/logbook/panel",
            capabilityBridge: {
              protocolVersion: 1,
              requiredMethods: ["chat.send"],
              optionalMethods: ["chat.history"],
            },
          }),
        },
      ],
      [{ pluginId: "logbook", path: "/plugins/logbook", match: "prefix" }],
    );

    const [tab] = listControlUiPluginTabs(["operator.read"], {
      availableMethods: ["chat.history", "chat.send"],
    });

    expect(tab?.capabilityBridge).toMatchObject({
      methods: ["chat.history"],
      missingRequiredMethods: ["chat.send"],
      mode: "read-only",
      upgradeRequired: true,
    });
  });

  it("grants a same-plugin admin method only to an authenticated admin operator", () => {
    activateDescriptors(
      [
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({
            path: "/plugins/logbook/panel",
            capabilityBridge: {
              protocolVersion: 1,
              requiredMethods: ["logbook.attention.act"],
              optionalMethods: ["chat.history"],
            },
          }),
        },
      ],
      [{ pluginId: "logbook", path: "/plugins/logbook", match: "prefix" }],
      [{ pluginId: "logbook", name: "logbook.attention.act", scope: "operator.admin" }],
    );

    expect(
      listControlUiPluginTabs(["operator.admin"], {
        availableMethods: ["logbook.attention.act", "chat.history"],
      })[0]?.capabilityBridge,
    ).toMatchObject({
      methods: ["logbook.attention.act", "chat.history"],
      mode: "read-write",
      missingRequiredMethods: [],
    });
    expect(
      listControlUiPluginTabs(["operator.write"], {
        availableMethods: ["logbook.attention.act", "chat.history"],
      })[0]?.capabilityBridge,
    ).toMatchObject({
      methods: ["chat.history"],
      mode: "read-only",
      missingRequiredMethods: ["logbook.attention.act"],
      upgradeRequired: true,
    });
  });

  it("keeps an otherwise-visible tab read-only without a same-plugin authenticated route", () => {
    activateDescriptors([
      {
        pluginId: "logbook",
        descriptor: tabDescriptor({
          path: "/plugins/logbook/panel",
          capabilityBridge: {
            protocolVersion: 1,
            requiredMethods: ["chat.history"],
            optionalMethods: [],
          },
        }),
      },
    ]);

    const [tab] = listControlUiPluginTabs(["operator.read"], {
      availableMethods: ["chat.history"],
    });

    expect(tab).toMatchObject({ pluginId: "logbook" });
    expect(tab).not.toHaveProperty("capabilityBridge");
    expect(tab).not.toHaveProperty("requiresGatewayAuth");
  });

  it("grants only same-plugin gateway routes with least-privilege scopes", () => {
    activateDescriptors(
      [
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({ path: "/plugins/logbook/panel" }),
        },
        {
          pluginId: "adminy",
          descriptor: tabDescriptor({
            id: "adminy",
            path: "/plugins/adminy/panel",
            requiredScopes: ["operator.admin"],
          }),
        },
        {
          pluginId: "publicish",
          descriptor: tabDescriptor({ id: "publicish", path: "/plugins/publicish/panel" }),
        },
      ],
      [
        { pluginId: "logbook", path: "/plugins/logbook", match: "prefix" },
        { pluginId: "adminy", path: "/plugins/adminy", match: "prefix" },
        {
          pluginId: "publicish",
          path: "/plugins/publicish",
          auth: "plugin",
          match: "prefix",
        },
      ],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
      {
        pluginId: "adminy",
        path: "/plugins/adminy",
        match: "prefix",
        scopes: ["operator.read"],
      },
      {
        pluginId: "logbook",
        path: "/plugins/logbook",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
    const adminTabs = listControlUiPluginTabs(["operator.admin"]);
    expect(adminTabs).toEqual([
      expect.objectContaining({
        pluginId: "adminy",
        requiresGatewayAuth: true,
      }),
      expect.objectContaining({
        pluginId: "logbook",
        requiresGatewayAuth: true,
      }),
      expect.objectContaining({
        pluginId: "publicish",
      }),
    ]);
    expect(adminTabs[2]).not.toHaveProperty("requiresGatewayAuth");
    expect(listControlUiPluginTabAuthGrants(["operator.read"])).toEqual([
      {
        pluginId: "logbook",
        path: "/plugins/logbook",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
  });

  it("matches gateway routes against descriptor URL pathnames", () => {
    const path = "/plugins/logbook/panel?view=activity#settings";
    activateDescriptors(
      [{ pluginId: "logbook", descriptor: tabDescriptor({ path }) }],
      [{ pluginId: "logbook", path: "/plugins/logbook/panel", match: "exact" }],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.read"])).toEqual([
      {
        pluginId: "logbook",
        path: "/plugins/logbook/panel",
        match: "exact",
        scopes: ["operator.read"],
      },
    ]);
    expect(listControlUiPluginTabs(["operator.read"])).toEqual([
      expect.objectContaining({ path, requiresGatewayAuth: true }),
    ]);
  });

  it("does not grant a matching route owned by another plugin", () => {
    activateDescriptors(
      [{ pluginId: "logbook", descriptor: tabDescriptor({ path: "/shared/panel" }) }],
      [{ pluginId: "other", path: "/shared", match: "prefix" }],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([]);
    expect(listControlUiPluginTabs(["operator.admin"])).toEqual([]);
  });

  it("uses the first dispatched gateway route as descriptor owner", () => {
    activateDescriptors(
      [{ pluginId: "outer", descriptor: tabDescriptor({ path: "/shared/panel" }) }],
      [
        { pluginId: "nested", path: "/shared/panel", match: "exact" },
        { pluginId: "outer", path: "/shared", match: "prefix" },
      ],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([]);
    expect(listControlUiPluginTabs(["operator.admin"])).toEqual([]);
  });

  it("does not require a cookie grant when gateway auth is disabled", () => {
    activateDescriptors(
      [{ pluginId: "logbook", descriptor: tabDescriptor({ path: "/plugins/logbook/panel" }) }],
      [{ pluginId: "logbook", path: "/plugins/logbook", match: "prefix" }],
    );

    const [tab] = listControlUiPluginTabs(["operator.admin"], {
      requireGatewayAuthGrant: false,
    });
    expect(tab).toMatchObject({ pluginId: "logbook" });
    expect(tab).not.toHaveProperty("requiresGatewayAuth");
  });

  it("coalesces same-plugin tabs that share one read-only cookie path", () => {
    activateDescriptors(
      [
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({ path: "/plugins/logbook/read" }),
        },
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({
            id: "admin",
            path: "/plugins/logbook/admin",
            requiredScopes: ["operator.admin"],
          }),
        },
      ],
      [{ pluginId: "logbook", path: "/plugins/logbook", match: "prefix" }],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
      {
        pluginId: "logbook",
        path: "/plugins/logbook",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
  });

  it("widens a shared exact cookie path when another visible tab needs prefix matching", () => {
    activateDescriptors(
      [
        { pluginId: "logbook", descriptor: tabDescriptor({ path: "/plugins/logbook" }) },
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({ id: "child", path: "/plugins/logbook/child" }),
        },
      ],
      [
        { pluginId: "logbook", path: "/plugins/logbook", match: "exact" },
        { pluginId: "logbook", path: "/plugins/logbook", match: "prefix" },
      ],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
      {
        pluginId: "logbook",
        path: "/plugins/logbook",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
  });

  it("keeps separate grants for different plugins that share a cookie path", () => {
    activateDescriptors(
      [
        { pluginId: "alpha", descriptor: tabDescriptor({ id: "alpha", path: "/shared" }) },
        {
          pluginId: "beta",
          descriptor: tabDescriptor({ id: "beta", path: "/shared/child" }),
        },
      ],
      [
        { pluginId: "alpha", path: "/shared", match: "exact" },
        { pluginId: "beta", path: "/shared", match: "prefix" },
      ],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
      {
        pluginId: "alpha",
        path: "/shared",
        match: "exact",
        scopes: ["operator.read"],
      },
      {
        pluginId: "beta",
        path: "/shared",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
    expect(listControlUiPluginTabs(["operator.admin"]).map((tab) => tab.pluginId)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("uses only the first route owner when plugins declare the same path", () => {
    activateDescriptors(
      [
        { pluginId: "alpha", descriptor: tabDescriptor({ id: "alpha", path: "/shared" }) },
        { pluginId: "beta", descriptor: tabDescriptor({ id: "beta", path: "/shared" }) },
      ],
      [
        { pluginId: "alpha", path: "/shared", match: "exact" },
        { pluginId: "beta", path: "/shared", match: "prefix" },
      ],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
      {
        pluginId: "alpha",
        path: "/shared",
        match: "exact",
        scopes: ["operator.read"],
      },
    ]);
    expect(listControlUiPluginTabs(["operator.admin"]).map((tab) => tab.pluginId)).toEqual([
      "alpha",
    ]);
  });
});
