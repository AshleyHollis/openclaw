import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as requestHttp } from "node:http";
import { createConnection } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { ensureDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { readJsonBodyWithLimit } from "../infra/http-body.js";
import { dispatchGatewayMethod } from "../plugin-sdk/gateway-method-runtime.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import {
  AUTH_TOKEN,
  createTestGatewayServer,
  sendRequest,
  withGatewayTempConfig,
} from "./server-http.test-harness.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import { createGatewayTestRegistry } from "./server/__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

describe("native Control UI HTTP admission", () => {
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    resetPluginRuntimeStateForTest();
  });

  // Real paired credentials and real route dispatch: an HTTP adapter mock would
  // miss scope widening, registry replacement, and fallthrough into hook handlers.
  it.each([
    { fault: "none", scopes: ["operator.read"], status: 403 },
    { fault: "none", scopes: ["operator.read", "operator.write"], status: 200 },
    { fault: "tcp-large", scopes: ["operator.read", "operator.write"], status: 200 },
    { fault: "tcp-request-limit", scopes: ["operator.read", "operator.write"], status: 413 },
    { fault: "tcp-chunked-limit", scopes: ["operator.read", "operator.write"], status: 413 },
    { fault: "tcp-chunked-valid", scopes: ["operator.read", "operator.write"], status: 200 },
    { fault: "tcp-disconnect-commit", scopes: ["operator.read", "operator.write"], status: 200 },
    { fault: "tcp-delayed-reader", scopes: ["operator.read", "operator.write"], status: 200 },
    ...["held", "ended"].map((kind) => ({
      fault: `tcp-early-${kind}`,
      scopes: ["operator.read", "operator.write"],
      status: 200,
    })),
    ...["empty", "fixed", "chunked"].map((kind) => ({
      fault: `tcp-zero-${kind}`,
      scopes: ["operator.read"],
      status: kind === "empty" ? 200 : 413,
    })),
    ...["exact", "end", "chunks", "utf8", "detached"].map((kind) => ({
      fault: `tcp-response-${kind}`,
      scopes: ["operator.read", "operator.write"],
      status: 200,
    })),
    { fault: "read", scopes: ["operator.read"], status: 200 },
    ...["dispatch-live", "dispatch-retired", "dispatch-detached", "dispatch-commit"].map(
      (fault) => ({
        fault,
        scopes: ["operator.read", "operator.write"],
        status: 200,
      }),
    ),
    ...[
      "disabled-ui",
      "stale",
      "registry",
      "reactivation",
      "hooks",
      "decline",
      "marker",
      "query",
      "alias",
      "foreign-prefix",
      "trusted-operator",
    ].map((fault) => ({
      fault,
      scopes: ["operator.read", "operator.write"],
      status: fault === "decline" ? 404 : 401,
    })),
  ])("enforces $scopes with $fault", async ({ fault, scopes, status }) => {
    const taskHome = dirs.make("native-relay-");
    await withEnvAsync(
      { OPENCLAW_HOME: taskHome, OPENCLAW_STATE_DIR: path.join(taskHome, "state") },
      async () => {
        await withGatewayTempConfig("native-relay-config-", async () => {
          const routePath = "/plugins/logbook/api/note";
          const method = fault === "read" || fault.startsWith("tcp-zero-") ? "GET" : "POST";
          const observed: string[][] = [];
          const entered = createDeferredCore();
          const release = createDeferredCore();
          const finished = createDeferredCore();
          const disconnected = createDeferredCore();
          const published = vi.fn();
          const written = vi.fn();
          const sessionHandler = vi.fn(
            async ({ respond, sessionMutationCommitGuard }: GatewayRequestHandlerOptions) => {
              if (fault === "dispatch-commit" || fault === "tcp-disconnect-commit") {
                entered.resolve();
                await release.promise;
              }
              sessionMutationCommitGuard?.();
              published();
              respond(true, { key: "agent:main:dashboard:relay" });
            },
          );
          const context = {
            trackExecution: trackAsyncWork,
            dedupe: new Map(),
            getRuntimeConfig: () => ({}),
            logGateway: { error: vi.fn(), warn: vi.fn() },
            getGatewayMethodRegistry: () =>
              createGatewayMethodRegistry([
                {
                  name: "sessions.create",
                  scope: "operator.write",
                  owner: { kind: "core", area: "sessions" },
                  handler: sessionHandler,
                },
              ]),
          } as unknown as GatewayRequestContext;
          let dispatched: Promise<unknown> | undefined;
          const dispatch = async () => {
            try {
              return await dispatchGatewayMethod("sessions.create", { agentId: "main" });
            } catch (error) {
              return error;
            }
          };
          const handler = vi.fn(async (req, res) => {
            observed.push(getPluginRuntimeGatewayRequestScope()?.client?.connect.scopes ?? []);
            if (fault === "tcp-early-held") {
              return true;
            }
            if (fault === "tcp-disconnect-commit") {
              req.socket.once("close", disconnected.resolve);
            }
            if (fault.startsWith("tcp-response-")) {
              res.statusCode = 200;
              if (fault === "tcp-response-exact") {
                expect(typeof res.write(Buffer.alloc(512, "x"), written)).toBe("boolean");
                res.end(new Uint8Array(512).fill(120));
              } else if (fault === "tcp-response-end") {
                res.end("x".repeat(1025));
              } else if (fault === "tcp-response-utf8") {
                res.end("é".repeat(513), "utf8");
              } else {
                res.write("x".repeat(512));
                if (fault === "tcp-response-detached") {
                  dispatched = finished.promise.then(() => {
                    res.end("x".repeat(513));
                  });
                } else {
                  res.end("x".repeat(513));
                }
              }
              return true;
            }
            if (fault === "dispatch-retired") {
              entered.resolve();
              await release.promise;
            }
            if (fault === "dispatch-detached") {
              dispatched = release.promise.then(dispatch);
            } else if (fault.startsWith("dispatch-") || fault === "tcp-disconnect-commit") {
              dispatched = dispatch();
              await dispatched;
            }
            if (fault === "tcp-delayed-reader") {
              await new Promise((resolve) => {
                setImmediate(resolve);
              });
              expect(req.readableEnded, "The limit observer must not consume an unread body").toBe(
                false,
              );
            }
            if (
              fault === "tcp-large" ||
              fault === "tcp-delayed-reader" ||
              fault.startsWith("tcp-chunked-")
            ) {
              const body = await readJsonBodyWithLimit(req, { maxBytes: 4 * 1024 * 1024 });
              if (!body.ok) {
                return true;
              }
              if (fault === "tcp-large") {
                expect(JSON.stringify(body.value).length).toBe(2 * 1024 * 1024 + 11);
              } else {
                dispatched = dispatch();
                await dispatched;
              }
            }
            if (fault === "decline") {
              return false;
            }
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end('{"saved":true}');
            return true;
          });
          const registry = createGatewayTestRegistry({
            httpRoutes: [
              {
                pluginId: "logbook",
                source: "fixture",
                path: routePath,
                auth: "gateway",
                match: "exact",
                gatewayMethodDispatchAllowed: true,
                handler,
                ...(fault === "trusted-operator"
                  ? { gatewayRuntimeScopeSurface: "trusted-operator" as const }
                  : {}),
              },
            ],
          });
          registry.plugins.push(
            createPluginRecord({
              id: "logbook",
              origin: fault === "disabled-ui" ? "workspace" : "bundled",
              controlUi: {
                entry: "dist/control-ui/index.js",
                httpRoutes: [
                  {
                    path: routePath,
                    method,
                    maxRequestBytes:
                      method === "GET"
                        ? 0
                        : fault.endsWith("-limit") || fault.startsWith("tcp-early-")
                          ? 1024
                          : 4 * 1024 * 1024,
                    maxResponseBytes: 1024,
                  },
                ],
              },
            }),
          );
          if (fault === "foreign-prefix") {
            registry.httpRoutes.push({
              pluginId: "foreign",
              source: "fixture",
              path: "/plugins/logbook",
              auth: "gateway",
              match: "prefix",
              handler,
            });
          }
          setActivePluginRegistry(registry);
          const handlePluginRequest = createGatewayPluginRequestHandler({
            registry,
            getGatewayRequestContext: () => context,
            getRouteRegistry: () => {
              if (fault === "reactivation") {
                setActivePluginRegistry(registry);
              }
              if (fault !== "registry") {
                return registry;
              }
              const replaced = {
                ...registry,
                httpRoutes: registry.httpRoutes.map((route) => ({ ...route, pluginId: "foreign" })),
              };
              setActivePluginRegistry(replaced);
              return replaced;
            },
            log: { warn: vi.fn() } as never,
          });
          const hookEffects = vi.fn();
          const server = createTestGatewayServer({
            resolvedAuth: AUTH_TOKEN,
            overrides: {
              controlUiEnabled: true,
              handlePluginRequest: async (...args) => {
                try {
                  return await handlePluginRequest(...args);
                } finally {
                  finished.resolve();
                }
              },
              shouldEnforcePluginGatewayAuth: () => true,
              handleHooksRequest: async (req, res) => {
                if (fault !== "hooks" || req.url !== routePath) {
                  return false;
                }
                hookEffects();
                res.end('{"hook":true}');
                return true;
              },
            },
          });
          const deviceId = `relay-${randomUUID()}`;
          const requested = await requestDevicePairing({
            deviceId,
            publicKey: "synthetic-public-key",
            role: "operator",
            scopes,
            clientId: "openclaw-control-ui",
            clientMode: "webchat",
          });
          const approved = await approveDevicePairing(requested.request.requestId, {
            callerScopes: scopes,
          });
          expect(approved?.status).toBe("approved");
          const issued = await ensureDeviceToken({
            deviceId,
            role: "operator",
            scopes,
            issuer: {
              kind: "shared-gateway-auth",
              generation:
                fault === "stale"
                  ? "stale-fixture-generation"
                  : resolveSharedGatewaySessionGeneration(AUTH_TOKEN, [])!,
            },
          });
          expect(issued?.token).toBeTruthy();
          if (fault.startsWith("tcp-")) {
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            try {
              const address = server.address();
              if (!address || typeof address === "string") {
                throw new Error("Missing test listener");
              }
              const url = `http://127.0.0.1:${address.port}${routePath}`;
              if (fault.startsWith("tcp-early-")) {
                const socket = createConnection({ host: "127.0.0.1", port: address.port });
                let output = "";
                let timedOut = false;
                socket.on("data", (chunk: Buffer) => {
                  output += chunk.toString();
                });
                socket.on("error", () => {});
                socket.setTimeout(3000, () => {
                  timedOut = true;
                  socket.destroy();
                });
                const closed = new Promise<void>((resolve) => {
                  socket.once("close", () => resolve());
                });
                try {
                  await once(socket, "connect");
                  const headers = `POST ${routePath} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${issued!.token}\r\nx-openclaw-control-ui-relay: 1\r\n`;
                  socket.write(`${headers}Transfer-Encoding: chunked\r\n\r\n1\r\na\r\n`);
                  await finished.promise;
                  socket.write(
                    `401\r\n${"x".repeat(1025)}\r\n0\r\n\r\n${headers}Content-Length: 0\r\nConnection: close\r\n\r\n`,
                  );
                  await closed;
                  expect(
                    timedOut,
                    "Abandoned upload must close without waiting for the client deadline",
                  ).toBe(false);
                  expect(handler).toHaveBeenCalledOnce();
                  if (fault === "tcp-early-held") {
                    expect(output).toContain("413");
                  }
                } finally {
                  socket.destroy();
                  await closed;
                }
                return;
              }
              if (fault.startsWith("tcp-zero-")) {
                const actual = await new Promise<number>((resolve, reject) => {
                  const request = requestHttp(
                    url,
                    {
                      method,
                      headers: {
                        authorization: `Bearer ${issued!.token}`,
                        "x-openclaw-control-ui-relay": "1",
                        ...(fault === "tcp-zero-chunked"
                          ? { "transfer-encoding": "chunked" }
                          : { "content-length": fault === "tcp-zero-empty" ? "0" : "1" }),
                      },
                      signal: AbortSignal.timeout(10_000),
                    },
                    (response) => {
                      response.resume();
                      response.on("error", reject);
                      response.on("end", () => resolve(response.statusCode!));
                    },
                  );
                  request.on("error", reject);
                  request.end(fault === "tcp-zero-empty" ? undefined : "x");
                });
                expect(actual).toBe(status);
                expect(handler).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
                return;
              }
              if (fault === "tcp-disconnect-commit") {
                const request = requestHttp(url, {
                  method,
                  headers: {
                    authorization: `Bearer ${issued!.token}`,
                    "x-openclaw-control-ui-relay": "1",
                  },
                  signal: AbortSignal.timeout(10_000),
                });
                request.on("error", () => {});
                request.end();
                try {
                  await entered.promise;
                  request.destroy();
                  await disconnected.promise;
                } finally {
                  release.resolve();
                }
                await finished.promise;
                expect(await dispatched).not.toMatchObject({ ok: true });
                expect(published).not.toHaveBeenCalled();
                return;
              }
              if (fault.startsWith("tcp-response-")) {
                const actual = await new Promise<{ complete: boolean; bytes: number }>(
                  (resolve) => {
                    let bytes = 0;
                    const request = requestHttp(
                      url,
                      {
                        method,
                        headers: {
                          authorization: `Bearer ${issued!.token}`,
                          "x-openclaw-control-ui-relay": "1",
                        },
                        signal: AbortSignal.timeout(10_000),
                      },
                      (response) => {
                        response.on("data", (chunk: Buffer) => {
                          bytes += chunk.length;
                        });
                        response.on("error", () => resolve({ complete: false, bytes }));
                        response.on("end", () => resolve({ complete: response.complete, bytes }));
                      },
                    );
                    request.on("error", () => resolve({ complete: false, bytes }));
                    request.end();
                  },
                );
                await finished.promise;
                await dispatched;
                expect(handler).toHaveBeenCalledOnce();
                expect(observed).toEqual([["operator.write"]]);
                expect(actual.complete).toBe(fault === "tcp-response-exact");
                expect(actual.bytes).toBeLessThanOrEqual(1024);
                if (fault === "tcp-response-exact") {
                  expect(actual.bytes).toBe(1024);
                  expect(written).toHaveBeenCalledOnce();
                }
                return;
              }
              if (fault.startsWith("tcp-chunked-")) {
                const actual = await new Promise<number>((resolve, reject) => {
                  const request = requestHttp(
                    url,
                    {
                      method,
                      headers: {
                        authorization: `Bearer ${issued!.token}`,
                        "content-type": "application/json",
                        "transfer-encoding": "chunked",
                        "x-openclaw-control-ui-relay": "1",
                      },
                      signal: AbortSignal.timeout(10_000),
                    },
                    (response) => {
                      response.resume();
                      response.on("error", reject);
                      response.on("end", () => resolve(response.statusCode!));
                    },
                  );
                  request.on("error", reject);
                  request.write('{"text":"');
                  request.end(`${"x".repeat(2048)}"}`);
                });
                expect(actual).toBe(status);
                await finished.promise;
                expect(published).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
                return;
              }
              const response = await fetch(url, {
                method,
                headers: {
                  authorization: `Bearer ${issued!.token}`,
                  "content-type": "application/json",
                  "x-openclaw-control-ui-relay": "1",
                },
                body: JSON.stringify({
                  text: "x".repeat(
                    fault === "tcp-request-limit" || fault === "tcp-delayed-reader"
                      ? 2048
                      : 2 * 1024 * 1024,
                  ),
                }),
                signal: AbortSignal.timeout(10_000),
              });
              expect(response.status).toBe(status);
              if (fault === "tcp-request-limit") {
                await response.arrayBuffer();
                expect(handler).not.toHaveBeenCalled();
                return;
              }
              expect(await response.json()).toEqual({ saved: true });
              expect(response.headers.has("set-cookie")).toBe(false);
              expect(observed).toEqual([["operator.write"]]);
              const anonymous = await fetch(url, {
                method,
                headers: { "x-openclaw-control-ui-relay": "1" },
                signal: AbortSignal.timeout(10_000),
              });
              expect(anonymous.status).toBe(401);
              await anonymous.arrayBuffer();
              expect(handler).toHaveBeenCalledTimes(1);
            } finally {
              server.closeAllConnections();
              await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
              });
            }
            return;
          }
          if (fault === "hooks") {
            setRuntimeConfigSnapshot({ hooks: { enabled: true, path: "/plugins/logbook" } });
          }
          const pendingResponse = sendRequest(server, {
            path:
              fault === "query"
                ? `${routePath}?extra=1`
                : fault === "alias"
                  ? "/plugins/logbook/api/../api/note"
                  : routePath,
            method,
            authorization: `Bearer ${issued!.token}`,
            headers: {
              "content-type": "application/json",
              "x-openclaw-control-ui-relay": fault === "marker" ? "bad" : "1",
            },
          });
          if (fault === "dispatch-retired" || fault === "dispatch-commit") {
            await entered.promise;
            setActivePluginRegistry(registry);
            release.resolve();
          }
          const response = await pendingResponse;
          if (fault === "dispatch-detached") {
            await finished.promise;
            release.resolve();
          }
          if (fault.startsWith("dispatch-")) {
            const result = await dispatched;
            if (fault === "dispatch-live") {
              expect(result).toMatchObject({ ok: true });
              expect(published).toHaveBeenCalledOnce();
            } else {
              expect(published).not.toHaveBeenCalled();
              if (fault !== "dispatch-commit") {
                expect(sessionHandler).not.toHaveBeenCalled();
              }
              expect(result).not.toMatchObject({ ok: true });
            }
          }
          expect(response.res.statusCode).toBe(status);
          expect(observed).toEqual(
            status === 200 || fault === "decline"
              ? [[method === "GET" ? "operator.read" : "operator.write"]]
              : [],
          );
          expect(hookEffects).not.toHaveBeenCalled();
          expect(
            response.setHeader.mock.calls.some(([name]) => name.toLowerCase() === "set-cookie"),
          ).toBe(false);
          handler.mockClear();
          const anonymous = await sendRequest(server, {
            path: routePath,
            method,
            headers: { "content-type": "application/json", "x-openclaw-control-ui-relay": "1" },
          });
          expect(anonymous.res.statusCode).toBe(401);
          expect(handler).not.toHaveBeenCalled();
        });
      },
    );
  });
});
