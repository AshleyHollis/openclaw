import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RouteId } from "../app-routes.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createGatewayHarness } from "../lib/sessions/session-capability.test-support.ts";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import { initializeControlUiPlugin } from "./control-ui-loader.ts";
import { ControlUiPluginRuntime } from "./control-ui-runtime.ts";

vi.mock("./control-ui-loader.ts", () => ({ initializeControlUiPlugin: vi.fn() }));

describe("native plugin asset admission", () => {
  it("revokes an activated plugin's pending HTTP write when the Gateway disconnects", async () => {
    const client = {
      gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
      request: vi.fn(async (method: string) =>
        method === "plugins.controlUi.list"
          ? {
              revision: "one",
              diagnostics: [],
              plugins: [
                {
                  pluginId: "review",
                  name: "Review",
                  revision: "one",
                  entryUrl: "/unused.js",
                  styles: [],
                  httpRoutes: [
                    {
                      path: "/plugins/review/notes",
                      method: "POST",
                      maxRequestBytes: 1024,
                      maxResponseBytes: 1024,
                    },
                  ],
                },
              ],
            }
          : { ok: true },
      ),
    } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    Object.assign(gateway, { connection: { token: "test-operator-token" } });
    const context = {
      gateway,
      resourceBasePath: "",
      basePath: "",
      config: { refresh: async () => ({ pluginAssetsRequireAuth: false, pluginFrameGrants: [] }) },
    } as unknown as ApplicationContext<RouteId>;
    const runtime = new ControlUiPluginRuntime(() => context);
    vi.mocked(initializeControlUiPlugin).mockImplementationOnce(
      async (getContext, current, owner) => {
        const host = createControlUiPluginHost(getContext, current, owner);
        host.ui.registerPage({ id: "notes", label: "Notes", mount: () => undefined });
        return Object.assign(owner, { host });
      },
    );
    const pending = createDeferred<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => pending.promise);
    try {
      runtime.start();
      await runtime.refresh();
      expect(runtime.errors).toEqual([]);
      const host = runtime.registrations("pages")[0]?.host;
      expect(host).toBeDefined();
      if (!host) throw new Error("Expected an activated page host");
      const saving = host.httpRequest({
        method: "POST",
        path: "/plugins/review/notes",
        body: "{}",
      });
      const outcome = saving.catch((error: unknown) => error);
      publish(false);
      const signalWasAborted = fetchMock.mock.calls[0]?.[1]?.signal?.aborted;
      pending.resolve(
        new Response('{"saved":true}', { headers: { "Content-Type": "application/json" } }),
      );
      expect(await outcome).toMatchObject({
        message: expect.stringContaining("outcome is unknown"),
      });
      expect(signalWasAborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(runtime.registrations("pages")).toEqual([]);
    } finally {
      pending.resolve(new Response());
      runtime.dispose();
      fetchMock.mockRestore();
      vi.mocked(initializeControlUiPlugin).mockReset();
    }
  });

  it.each([
    {
      scenario: "cross-origin native plugin",
      native: true,
      remote: true,
      error:
        "Native plugin UI requires the Control UI served by the connected Gateway. Open https://remote.example and reconnect there.",
    },
    { scenario: "ordinary remote connection", native: false, remote: true, error: null },
    {
      scenario: "missing native asset grant",
      native: true,
      remote: false,
      error: "Native plugin asset grant unavailable: review",
    },
    {
      scenario: "authenticated native plugin on plain HTTP",
      native: true,
      remote: false,
      secure: false,
      granted: true,
      error:
        "Native plugin UI requires HTTPS or localhost to authenticate its assets. Open this Gateway through HTTPS/Tailscale Serve, or use its loopback dashboard.",
    },
    {
      scenario: "native plugin without asset authentication on plain HTTP",
      native: true,
      remote: false,
      secure: false,
      requiresAuth: false,
      loads: true,
      error: null,
    },
    {
      scenario: "native plugin under a resource base path",
      native: true,
      remote: false,
      granted: true,
      loads: true,
      resourceBasePath: "/console",
      error: null,
    },
  ])(
    "settles $scenario without loading protected modules",
    async ({
      native,
      remote,
      error,
      secure = true,
      granted = false,
      requiresAuth = true,
      loads = false,
      resourceBasePath = "",
    }) => {
      vi.stubGlobal("isSecureContext", secure);
      vi.mocked(initializeControlUiPlugin).mockClear();
      const request = vi.fn(async (method: string) =>
        method === "plugins.controlUi.list"
          ? {
              revision: "catalog-one",
              diagnostics: [],
              plugins: native
                ? [
                    {
                      pluginId: "review",
                      name: "Review",
                      revision: "one",
                      entryUrl: `${resourceBasePath}/__openclaw__/plugins/control-ui/review/one/index.js`,
                      styles: [],
                    },
                  ]
                : [],
            }
          : { ok: true },
      );
      const refresh = vi.fn(async () => ({
        pluginAssetsRequireAuth: requiresAuth,
        pluginFrameGrants: granted
          ? [
              {
                pluginId: "review",
                match: "prefix",
                path: `${resourceBasePath}/__openclaw__/plugins/control-ui/review/`,
              },
            ]
          : [],
      }));
      const context = {
        basePath: "/navigation-only",
        resourceBasePath,
        gateway: {
          snapshot: {
            phase: "connected",
            client: {
              gatewayUrl: remote
                ? "wss://remote.example/ws"
                : window.location.origin.replace(/^http/u, "ws"),
              request,
            },
            hello: {
              features: { methods: ["plugins.controlUi.list", "plugins.controlUi.report"] },
            },
          },
          subscribe: () => () => undefined,
          subscribeEvents: () => () => undefined,
        },
        config: { refresh },
      } as unknown as ApplicationContext<RouteId>;
      const runtime = new ControlUiPluginRuntime(() => context);
      try {
        runtime.start();
        await runtime.refresh();
        expect(runtime.errors).toEqual(error ? [{ pluginId: "review", message: error }] : []);
        expect(
          request.mock.calls.filter(([method]) => method === "plugins.controlUi.report"),
        ).toEqual(
          error
            ? [
                [
                  "plugins.controlUi.report",
                  { pluginId: "review", revision: "one", status: "failed", error },
                ],
              ]
            : [],
        );
        expect(refresh).toHaveBeenCalledTimes(remote ? 0 : 1);
        expect(initializeControlUiPlugin).toHaveBeenCalledTimes(loads ? 1 : 0);
        expect(runtime.registrations("pages")).toEqual([]);
        expect(runtime.isLoading("review")).toBe(false);
      } finally {
        runtime.dispose();
        vi.unstubAllGlobals();
      }
    },
  );
});
