import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { dispatchGatewayMethod } from "./gateway-method-runtime.js";
/**
 * Tests gateway method runtime wrappers exposed to plugins.
 */
import { createPluginRegistryFixture, registerVirtualTestPlugin } from "./plugin-test-contracts.js";

const { dispatchGatewayMethodInProcessRaw } = vi.hoisted(() => ({
  dispatchGatewayMethodInProcessRaw: vi.fn(),
}));

vi.mock("../gateway/server-plugins.js", () => ({
  dispatchGatewayMethodInProcessRaw,
}));

describe("plugin-sdk/gateway-method-runtime", () => {
  it("rejects callers without the gateway method dispatch contract", async () => {
    await expect(
      withPluginRuntimeGatewayRequestScope(
        {
          pluginId: "plain-plugin",
          client: {
            id: "plugin",
            connect: { scopes: ["operator.write"] },
          } as never,
          isWebchatConnect: () => false,
        },
        () => dispatchGatewayMethod("health", {}),
      ),
    ).rejects.toThrow(
      'contracts.gatewayMethodDispatch: ["authenticated-request"] for plugin "plain-plugin"',
    );
    expect(dispatchGatewayMethodInProcessRaw).not.toHaveBeenCalled();
  });

  it("dispatches through the scoped client for entitled plugin HTTP routes", async () => {
    dispatchGatewayMethodInProcessRaw.mockResolvedValueOnce({ ok: true, payload: { ok: true } });

    const result = await withPluginRuntimeGatewayRequestScope(
      {
        pluginId: "admin-http-rpc",
        gatewayMethodDispatchAllowed: true,
        client: {
          id: "plugin",
          connect: { scopes: ["operator.admin"] },
        } as never,
        isWebchatConnect: () => false,
      },
      () => dispatchGatewayMethod("health", {}, { timeoutMs: 500 }),
    );

    expect(result).toEqual({ ok: true, payload: { ok: true } });
    expect(dispatchGatewayMethodInProcessRaw).toHaveBeenCalledWith(
      "health",
      {},
      {
        disableSyntheticClient: true,
        requireScopedClient: true,
        timeoutMs: 500,
      },
    );
  });
  it("limits a plugin Gateway handler to its exact declared methods", async () => {
    dispatchGatewayMethodInProcessRaw.mockClear();
    dispatchGatewayMethodInProcessRaw.mockResolvedValueOnce({ ok: true, payload: { groups: [] } });
    const { registry, config } = createPluginRegistryFixture();
    registerVirtualTestPlugin({
      registry,
      config,
      id: "command-center",
      name: "Command Center",
      contracts: { gatewayMethodDispatch: ["authenticated-request"] },
      register(api) {
        api.registerGatewayMethod(
          "command-center.groups",
          async () => {
            expect(getPluginRuntimeGatewayRequestScope()?.gatewayMethodDispatchMethods).toEqual([
              "sessions.groups.list",
            ]);
            await dispatchGatewayMethod("sessions.groups.list", {});
            await expect(dispatchGatewayMethod("sessions.groups.put", {})).rejects.toThrow(
              "exact allowlist",
            );
          },
          {
            scope: "operator.read",
            gatewayMethodDispatchMethods: ["sessions.groups.list"],
          },
        );
      },
    });
    const client = {
      connect: { scopes: ["operator.read"] },
    } as GatewayRequestHandlerOptions["client"];
    await withPluginRuntimeGatewayRequestScope({ client, isWebchatConnect: () => false }, () =>
      registry.registry.gatewayHandlers["command-center.groups"]!({
        client,
        context: {} as never,
        isWebchatConnect: () => false,
        params: {},
        req: { type: "req", id: "command-center-test", method: "command-center.groups" },
        respond: vi.fn(),
      }),
    );
    expect(dispatchGatewayMethodInProcessRaw).toHaveBeenCalledTimes(1);
  });
  it.each([
    { entitled: true, client: true },
    { entitled: false, client: true },
    { entitled: true, client: false },
  ])(
    "keeps registered RPC dispatch caller-bound (contract=$entitled, client=$client)",
    async ({ entitled, client: hasClient }) => {
      dispatchGatewayMethodInProcessRaw.mockClear();
      const { registry, config } = createPluginRegistryFixture();
      const client = hasClient
        ? ({ connect: { scopes: ["operator.read"] } } as GatewayRequestHandlerOptions["client"])
        : null;
      dispatchGatewayMethodInProcessRaw.mockImplementation(async () => {
        expect(getPluginRuntimeGatewayRequestScope()?.client).toBe(client);
        return { ok: true, payload: { ok: true } };
      });
      registerVirtualTestPlugin({
        registry,
        config,
        id: "reader",
        name: "Reader",
        contracts: entitled ? { gatewayMethodDispatch: ["authenticated-request"] } : {},
        register(api) {
          api.registerGatewayMethod(
            "reader.preview",
            async () => {
              await dispatchGatewayMethod("health", {});
            },
            { scope: "operator.read" },
          );
        },
      });
      const handler = registry.registry.gatewayHandlers["reader.preview"];
      if (!handler) {
        throw new Error("Missing registered handler");
      }
      const invoke = () =>
        withPluginRuntimeGatewayRequestScope(
          {
            client,
            context: {} as never,
            isWebchatConnect: () => false,
            gatewayMethodDispatchAllowed: true,
          },
          () =>
            handler({
              client,
              context: {} as never,
              isWebchatConnect: () => false,
              params: {},
              req: { type: "req", id: "reader-test", method: "reader.preview" },
              respond: vi.fn(),
            }),
        );
      if (entitled && hasClient) {
        await invoke();
        expect(dispatchGatewayMethodInProcessRaw).toHaveBeenCalledWith(
          "health",
          {},
          { disableSyntheticClient: true, requireScopedClient: true },
        );
      } else {
        await expect(invoke()).rejects.toThrow("contracts.gatewayMethodDispatch");
        expect(dispatchGatewayMethodInProcessRaw).not.toHaveBeenCalled();
      }
    },
  );
});
