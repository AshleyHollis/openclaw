import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type {
  GatewayRequestHandlerOptions,
  GatewayRequestOptions,
} from "./server-methods/types.js";

const writeFence = vi.hoisted(() => ({
  before: undefined as (() => void | Promise<void>) | undefined,
  after: undefined as (() => void) | undefined,
}));

// Pause before delegating to the real broker, whose synchronous admission guard
// still decides whether the worker may receive this mutation.
vi.mock("openclaw/plugin-sdk/sqlite-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugin-sdk/sqlite-runtime.js")>();
  return {
    ...actual,
    openSqliteWorkerStore: (async (...args) => {
      const store = await actual.openSqliteWorkerStore(...args);
      if (!store) {
        return store;
      }
      const execute = store.execute.bind(store);
      // Unprotected writes take the direct handle path. Keep the same pause on
      // that path so the regression revokes authority on the original code too.
      store.execute = (async (command, options) => {
        const cardWrite =
          command.type === "cards.register" || command.type === "cards.registerIfUpdatedAt";
        if (cardWrite) {
          await writeFence.before?.();
        }
        const result = await execute(command, options);
        if (cardWrite) {
          writeFence.after?.();
        }
        return result;
      }) as typeof store.execute;
      return store;
    }) as typeof actual.openSqliteWorkerStore,
    runSqliteWorkerStoreOperation: (async (...args) => {
      await writeFence.before?.();
      const result = await actual.runSqliteWorkerStoreOperation(...args);
      writeFence.after?.();
      return result;
    }) as typeof actual.runSqliteWorkerStoreOperation,
    runSqliteWorkerStoreWrite: (async (...args) => {
      await writeFence.before?.();
      const result = await actual.runSqliteWorkerStoreWrite(...args);
      writeFence.after?.();
      return result;
    }) as typeof actual.runSqliteWorkerStoreWrite,
  };
});

afterEach(() => {
  writeFence.before = undefined;
  writeFence.after = undefined;
  resetPluginRuntimeStateForTest();
});

describe("authenticated Workboard SQLite mutation admission", () => {
  it("uses the original host authority and revision for create/update, preserving accepted response loss", async () => {
    await withOpenClawTestState({ label: "workboard-authority" }, async () => {
      const { default: workboard } = await loadBundledPluginFacade<{
        default: { register(api: ReturnType<typeof createTestPluginApi>): void };
      }>({ pluginId: "workboard", artifactBasename: "index.js" });
      const descriptors: ReturnType<typeof createPluginGatewayMethodDescriptor>[] = [];
      const disposals: Array<() => void | Promise<void>> = [];
      const queuedHandlerEntered = createDeferredCore();
      const api = createTestPluginApi({
        runtimeSource: resolveBundledPluginPublicModulePath({
          pluginId: "workboard",
          artifactBasename: "index.js",
        }),
        registerGatewayMethod(name, handler, options) {
          descriptors.push(
            createPluginGatewayMethodDescriptor({
              pluginId: "workboard",
              name,
              handler: async (invocation: GatewayRequestHandlerOptions) => {
                if (invocation.params.title === "Fictional queued reminder") {
                  queuedHandlerEntered.resolve();
                }
                return await handler(invocation);
              },
              scope: options?.scope ?? "operator.read",
            }),
          );
        },
        registerRuntimeLifecycle(lifecycle) {
          if (lifecycle.dispose) {
            disposals.push(lifecycle.dispose);
          }
        },
      });
      workboard.register(api);
      const registry = createGatewayMethodRegistry(descriptors);
      setActivePluginRegistry(createEmptyPluginRegistry());
      let current = true;
      const client = {
        connId: "fictional-inbox-client",
        connect: {
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          client: { id: "cli", version: "test", platform: "test", mode: "cli" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as GatewayRequestOptions["client"];
      let requestId = 0;
      const invoke = async (
        method: string,
        params: Record<string, unknown>,
        respond = vi.fn(),
        caller = { client, hasCurrentClientAuthority: () => current },
      ) => {
        await handleGatewayRequest({
          req: { type: "req", id: `fictional-operation-${++requestId}`, method, params },
          ...caller,
          respond,
          isWebchatConnect: () => false,
          context: {
            getRuntimeConfig: () => ({}),
            getCommittedRuntimeConfig: () => ({}),
            logGateway: { warn: vi.fn() },
          } as unknown as GatewayRequestOptions["context"],
          methodRegistry: registry,
        });
        return respond;
      };
      try {
        const seeded = await invoke("workboard.cards.create", { title: "Fictional invoice" });
        expect(seeded.mock.calls[0]?.[2]).toBeUndefined();
        expect(seeded.mock.calls[0]?.[0]).toBe(true);
        const original = seeded.mock.calls[0]![1].card;
        for (const method of ["create", "update"] as const) {
          const params =
            method === "create"
              ? { title: "Fictional second invoice" }
              : {
                  id: original.id,
                  expectedUpdatedAt: original.updatedAt,
                  patch: { status: "done" },
                };
          current = true;
          writeFence.before = () => {
            current = false;
          };
          const refused = await invoke(`workboard.cards.${method}`, params);
          expect(refused.mock.calls[0]?.[0]).toBe(false);
          expect(refused.mock.calls[0]?.[2]?.message).toContain("authority changed");
          writeFence.before = undefined;
          current = true;
          const listed = await invoke("workboard.cards.list", {});
          expect(listed.mock.calls[0]?.[1]?.cards).toEqual([original]);
        }

        const entered = createDeferredCore();
        const release = createDeferredCore();
        writeFence.before = async () => {
          entered.resolve();
          await release.promise;
        };
        const admitted = invoke("workboard.cards.update", {
          id: original.id,
          expectedUpdatedAt: original.updatedAt,
          patch: { status: "done" },
        });
        await entered.promise;
        client!.connect.scopes = ["operator.read"];
        release.resolve();
        expect((await admitted).mock.calls[0]?.[0]).toBe(false);
        writeFence.before = undefined;
        client!.connect.scopes = ["operator.read", "operator.write"];

        writeFence.before = () => {
          client!.authenticatedUserId = "fictional-replacement-identity";
        };
        const changedIdentity = await invoke("workboard.cards.update", {
          id: original.id,
          expectedUpdatedAt: original.updatedAt,
          patch: { status: "done" },
        });
        expect(changedIdentity.mock.calls[0]?.[0]).toBe(false);
        delete client!.authenticatedUserId;
        writeFence.before = undefined;

        const blockerEntered = createDeferredCore();
        const blockerRelease = createDeferredCore();
        writeFence.before = async () => {
          writeFence.before = undefined;
          blockerEntered.resolve();
          await blockerRelease.promise;
        };
        const blocker = invoke("workboard.cards.create", { title: "Fictional queue blocker" });
        await blockerEntered.promise;
        let queuedCurrent = true;
        const queued = invoke(
          "workboard.cards.create",
          { title: "Fictional queued reminder" },
          vi.fn(),
          {
            client: {
              ...client!,
              connId: "fictional-second-client",
              connect: { ...client!.connect },
            },
            hasCurrentClientAuthority: () => queuedCurrent,
          },
        );
        await queuedHandlerEntered.promise;
        queuedCurrent = false;
        blockerRelease.resolve();
        expect((await blocker).mock.calls[0]?.[0]).toBe(true);
        expect((await queued).mock.calls[0]?.[0]).toBe(false);

        writeFence.after = () => {
          current = false;
        };
        const lost = vi.fn(() => {
          throw new Error("fictional response lost");
        });
        await expect(
          invoke(
            "workboard.cards.update",
            {
              id: original.id,
              expectedUpdatedAt: original.updatedAt,
              patch: { status: "done" },
            },
            lost,
          ),
        ).rejects.toThrow("fictional response lost");
        writeFence.after = undefined;
        current = true;
        const settled = await invoke("workboard.cards.list", {});
        expect(settled.mock.calls[0]?.[1]?.cards).toHaveLength(2);
        expect(settled.mock.calls[0]?.[1]?.cards).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: original.id, status: "done" }),
            expect.objectContaining({ title: "Fictional queue blocker" }),
          ]),
        );
        const stale = await invoke("workboard.cards.update", {
          id: original.id,
          expectedUpdatedAt: original.updatedAt,
          patch: { title: "Stale fictional edit" },
        });
        expect(stale.mock.calls[0]?.[2]?.code).toBe("workboard_conflict");
      } finally {
        writeFence.before = undefined;
        writeFence.after = undefined;
        await Promise.all(disposals.map(async (dispose) => await dispose()));
      }
    });
  });
});
