import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { registerWorkboardGatewayMethods } from "../../extensions/workboard/runtime-api.js";
import { observeSqliteWorkerAdmissionForTest } from "../../test/helpers/sqlite-worker-admission-observer.js";
import { createSessionTranscriptVisibleMessageDigest } from "../config/sessions/session-transcript-visible-message.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { dispatchGatewayMethod } from "../plugin-sdk/gateway-method-runtime.js";
import {
  assertSessionTranscriptGatewaySourceAdmissionAvailable,
  SESSION_TRANSCRIPT_GATEWAY_SOURCE_ADMISSION_VERSION,
  type SessionTranscriptGatewaySource,
} from "../plugin-sdk/gateway-runtime.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { patchSessionEntry, upsertSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import {
  appendSessionTranscriptMessageByIdentityStrict,
  readSessionTranscriptVisibleMessageDelta,
} from "../plugin-sdk/session-transcript-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.types.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { RuntimeGatewayRequestOptions } from "../plugins/runtime/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

it("refuses an independently injected legacy host before invoking its transport", () => {
  const request = vi.fn(async () => {
    throw new Error("Legacy transport must not be invoked");
  });
  const runtime = createPluginRuntime({ gateway: { isAvailable: async () => true, request } });
  expect(SESSION_TRANSCRIPT_GATEWAY_SOURCE_ADMISSION_VERSION).toBe(1);
  expect(runtime.gateway.sessionTranscriptSourceAdmissionVersion).toBeUndefined();
  expect(() => assertSessionTranscriptGatewaySourceAdmissionAvailable(runtime.gateway)).toThrow(
    "Gateway host",
  );
  expect(request).not.toHaveBeenCalled();
});

function writerBusy(databasePath: string): boolean {
  if (!fs.existsSync(databasePath)) {
    return false;
  }
  const peer = new DatabaseSync(databasePath);
  try {
    peer.exec("PRAGMA busy_timeout=0");
    peer.exec("BEGIN IMMEDIATE; ROLLBACK");
    return false;
  } catch (error) {
    if (!(error instanceof Error) || !("errcode" in error) || error.errcode !== 5) {
      throw error;
    }
    return true;
  } finally {
    peer.close();
  }
}

async function withSourceGateway(
  run: (fixture: {
    invoke: <T>(
      method: string,
      input: Record<string, unknown>,
      options?: RuntimeGatewayRequestOptions,
    ) => Promise<T>;
    publicInvoke: <T>(
      method: string,
      input: Record<string, unknown>,
      options?: RuntimeGatewayRequestOptions,
      admission?: "entitled" | "allowlisted" | "denied" | "missing-client",
    ) => Promise<T>;
    retirePublicAuthority: () => void;
    publicScope: () => PluginRuntimeGatewayRequestScope;
    source: SessionTranscriptGatewaySource;
    input: Record<string, unknown>;
    client: ReturnType<typeof createOperatorClient>;
    config: OpenClawConfig;
    readPolicy: { others: "view" | "none" };
    sourcePath: string;
    destinationPath: string;
    beforeHandler: (hook?: (request: GatewayRequestHandlerOptions) => Promise<void> | void) => void;
    sourceScope: { agentId: string; sessionKey: string; sessionId: string };
    loseResponse: () => Promise<void>;
    directInvoke: <T>(options: RuntimeGatewayRequestOptions) => Promise<T>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const readPolicy: { others: "view" | "none" } = { others: "view" };
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }] },
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: {
              agents: "*",
              scopes: ["operator.read", "operator.write"],
              sessions: readPolicy,
            },
          },
        },
      },
    };
    await state.writeConfig(config);
    const reader = ensureProfileForEmail("plan-reader@example.test");
    const owner = ensureProfileForEmail("plan-owner@example.test");
    setUserProfileRole(reader.id, "reader");
    const sourceScope = {
      agentId: "main",
      sessionKey: "agent:main:approved-plan-source",
      sessionId: "approved-plan-source-one",
    };
    await upsertSessionEntry({
      ...sourceScope,
      entry: {
        sessionId: sourceScope.sessionId,
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: owner.id },
      },
    });
    await appendSessionTranscriptMessageByIdentityStrict({
      ...sourceScope,
      eventId: "selected-plan",
      message: { role: "assistant", content: "Fictional accepted plan" },
    });
    const page = await readSessionTranscriptVisibleMessageDelta({
      ...sourceScope,
      maxMessages: 1,
      maxBytes: 100_000,
    });
    if (page.kind !== "page" || !page.entries[0]) {
      throw new Error("Native source fixture is unavailable");
    }
    const source: SessionTranscriptGatewaySource = {
      selection: {
        ...sourceScope,
        entryId: page.entries[0].entryId,
        generation: page.generation,
        digest: createSessionTranscriptVisibleMessageDigest(page.entries[0]),
      },
      assertCurrent() {},
    };
    const input = {
      title: "Fictional tracked plan",
      sessionKey: sourceScope.sessionKey,
      agentId: sourceScope.agentId,
      idempotencyKey: "accepted-plan-create",
      tenant: "fictional-tenant",
      metadata: { automation: { tenant: "fictional-tenant" } },
    };
    const descriptors: ReturnType<typeof createPluginGatewayMethodDescriptor>[] = [];
    const disposals: Array<() => void | Promise<void>> = [];
    let beforeHandler:
      | ((request: GatewayRequestHandlerOptions) => Promise<void> | void)
      | undefined;
    const runtime = createPluginRuntime();
    expect(runtime.gateway.sessionTranscriptSourceAdmissionVersion).toBe(
      SESSION_TRANSCRIPT_GATEWAY_SOURCE_ADMISSION_VERSION,
    );
    assertSessionTranscriptGatewaySourceAdmissionAvailable(runtime.gateway);
    const api = createTestPluginApi({
      runtime,
      runtimeSource: fileURLToPath(new URL("../../extensions/workboard/index.ts", import.meta.url)),
      registerGatewayMethod(name, handler, options) {
        descriptors.push(
          createPluginGatewayMethodDescriptor({
            pluginId: "workboard",
            name,
            scope: options?.scope,
            handler: async (request: GatewayRequestHandlerOptions) => {
              if (name === "workboard.cards.create") {
                await beforeHandler?.(request);
              }
              await handler(request);
            },
          }),
        );
      },
      registerRuntimeLifecycle(lifecycle) {
        if (lifecycle.dispose) {
          disposals.push(lifecycle.dispose);
        }
      },
    });
    registerWorkboardGatewayMethods({ api });
    const registry = createGatewayMethodRegistry(descriptors);
    setActivePluginRegistry(createEmptyPluginRegistry());
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      getCommittedRuntimeConfig: () => config,
      getGatewayMethodRegistry: () => registry,
    });
    const projection = await createSessionRowProjection({ cfg: config, context, modelCatalog: [] });
    bindSessionRowProjection(context, () => projection);
    const client = createOperatorClient({
      profileId: reader.id,
      scopes: ["operator.read", "operator.write"],
    });
    let publicAuthorityCurrent = true;
    let publicRequestScope: PluginRuntimeGatewayRequestScope | undefined;
    const invoke = <T>(
      method: string,
      params: Record<string, unknown>,
      options?: RuntimeGatewayRequestOptions,
    ) =>
      withPluginRuntimeGatewayRequestScope(
        {
          pluginId: "command-center",
          pluginOrigin: "bundled",
          client,
          context,
          hasCurrentClientAuthority: () => !client.invalidated,
          isWebchatConnect: () => false,
        },
        () => runtime.gateway.request<T>(method, params, options),
      );
    try {
      await projection.ensureMaterialized();
      await run({
        invoke,
        source,
        input,
        client,
        config,
        readPolicy,
        directInvoke: async <T>(options: RuntimeGatewayRequestOptions) => {
          let result: unknown;
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "fictional-direct-router",
              method: "workboard.cards.create",
              params: input,
            },
            client,
            context,
            methodRegistry: registry,
            isWebchatConnect: () => false,
            hasCurrentClientAuthority: () => !client.invalidated,
            sessionTranscriptSource: options.sessionTranscriptSource,
            respond: (success, payload, error) => {
              if (!success) {
                throw new Error(error?.message ?? "Native direct router refused");
              }
              result = payload;
            },
          });
          return result as T;
        },
        publicInvoke: async <T>(
          method: string,
          params: Record<string, unknown>,
          options?: RuntimeGatewayRequestOptions,
          admission = "entitled",
        ) => {
          publicRequestScope = {
            pluginId: "command-center",
            pluginOrigin: "config",
            client: admission === "missing-client" ? undefined : client,
            context,
            gatewayMethodDispatchAllowed:
              admission === "entitled" || admission === "missing-client",
            gatewayMethodDispatchMethods:
              admission === "allowlisted" ? ["workboard.cards.create"] : [],
            hasCurrentClientAuthority: () => publicAuthorityCurrent && !client.invalidated,
            isWebchatConnect: () => false,
          };
          const response = await withPluginRuntimeGatewayRequestScope(publicRequestScope, () =>
            dispatchGatewayMethod(method, params, options),
          );
          if (!response.ok) {
            throw new Error(response.error?.message ?? "Authenticated public dispatch refused");
          }
          return response.payload as T;
        },
        publicScope: () => {
          if (!publicRequestScope) {
            throw new Error("Original public request scope is unavailable");
          }
          return publicRequestScope;
        },
        retirePublicAuthority: () => {
          publicAuthorityCurrent = false;
        },
        sourceScope,
        sourcePath: resolveOpenClawAgentSqlitePath(sourceScope),
        destinationPath: path.join(state.stateDir, "plugins", "workboard", "workboard.sqlite"),
        beforeHandler: (hook) => {
          beforeHandler = hook;
        },
        loseResponse: async () => {
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "fictional-lost-response",
              method: "workboard.cards.create",
              params: input,
            },
            client,
            context,
            methodRegistry: registry,
            isWebchatConnect: () => false,
            hasCurrentClientAuthority: () => !client.invalidated,
            sessionTranscriptSource: source,
            respond: () => {
              throw new Error("Fictional response lost");
            },
          });
        },
      });
    } finally {
      await Promise.all(disposals.map(async (dispose) => await dispose()));
      projection.dispose();
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

it("uses the actual runtime Gateway request and authenticated handler with source custody through card COMMIT", async () => {
  await withSourceGateway(async (f) => {
    const observer = observeSqliteWorkerAdmissionForTest();
    const stages = new Set<string>();
    const source = {
      ...f.source,
      assertCurrent() {
        const stage = observer.currentRequest?.stage;
        if ((stage === "transaction" || stage === "commit") && writerBusy(f.destinationPath)) {
          stages.add(stage);
          expect(writerBusy(f.sourcePath)).toBe(true);
        }
      },
    };
    try {
      const created = await f.invoke<{ card: { id: string } }>("workboard.cards.create", f.input, {
        sessionTranscriptSource: source,
      });
      expect(stages).toEqual(new Set(["transaction", "commit"]));
      expect(writerBusy(f.sourcePath)).toBe(false);
      const replays = await Promise.all(
        [1, 2].map(() =>
          f.invoke<{ card: { id: string } }>("workboard.cards.create", f.input, {
            sessionTranscriptSource: f.source,
          }),
        ),
      );
      expect(replays.map((value) => value.card.id)).toEqual([created.card.id, created.card.id]);
      await expect(
        f.invoke(
          "workboard.cards.create",
          { ...f.input, title: "Changed immutable intent" },
          { sessionTranscriptSource: f.source },
        ),
      ).rejects.toThrow();
      const otherTenant = await f.invoke<{
        card: { id: string; metadata?: { automation?: { tenant?: string } } };
      }>(
        "workboard.cards.create",
        {
          ...f.input,
          tenant: "other-tenant",
          metadata: { automation: { tenant: "other-tenant" } },
        },
        { sessionTranscriptSource: f.source },
      );
      expect(otherTenant.card.id).not.toBe(created.card.id);
      expect(otherTenant.card.metadata?.automation?.tenant).toBe("other-tenant");
      const listed = await f.invoke<{ cards: unknown[] }>("workboard.cards.list", {});
      expect(listed.cards).toHaveLength(2);
    } finally {
      observer.restore();
    }
  });
});

it("retains initial native custody when the caller clears the mutable request option", async () => {
  await withSourceGateway(async (f) => {
    const observer = observeSqliteWorkerAdmissionForTest();
    const stages = new Set<string>();
    const options: RuntimeGatewayRequestOptions = {
      sessionTranscriptSource: {
        ...f.source,
        assertCurrent() {
          options.sessionTranscriptSource = undefined;
          const stage = observer.currentRequest?.stage;
          if ((stage === "transaction" || stage === "commit") && writerBusy(f.destinationPath)) {
            stages.add(stage);
            expect(writerBusy(f.sourcePath)).toBe(true);
          }
        },
      },
    };
    try {
      await f.invoke("workboard.cards.create", f.input, options);
      expect(options.sessionTranscriptSource).toBeUndefined();
      expect(stages).toEqual(new Set(["transaction", "commit"]));
      expect(writerBusy(f.sourcePath)).toBe(false);
    } finally {
      observer.restore();
    }
  });
});

it("captures direct-router selection and original guard before the first callback", async () => {
  await withSourceGateway(async (f) => {
    const observer = observeSqliteWorkerAdmissionForTest();
    const stages = new Set<string>();
    let calls = 0;
    const source = {
      selection: { ...f.source.selection },
      assertCurrent() {
        calls += 1;
        if (calls === 1) {
          source.selection.sessionId = "foreign-selected-incarnation";
          source.assertCurrent = () => {
            throw new Error("Replacement guard must not be adopted");
          };
        }
        const stage = observer.currentRequest?.stage;
        if ((stage === "transaction" || stage === "commit") && writerBusy(f.destinationPath)) {
          stages.add(stage);
          expect(writerBusy(f.sourcePath)).toBe(true);
        }
      },
    };
    try {
      const created = await f.directInvoke<{ card: { id: string } }>({
        sessionTranscriptSource: source,
      });
      expect(created.card.id).toBeTruthy();
      expect(calls).toBeGreaterThan(1);
      expect(stages).toEqual(new Set(["transaction", "commit"]));
      expect(writerBusy(f.sourcePath)).toBe(false);
    } finally {
      observer.restore();
    }
  });
});

it("refuses direct-router principal replacement during the first source callback", async () => {
  await withSourceGateway(async (f) => {
    const originalUser = f.client.authenticatedUserId;
    try {
      await expect(
        f.directInvoke({
          sessionTranscriptSource: {
            ...f.source,
            assertCurrent() {
              f.client.authenticatedUserId = "foreign-first-callback-principal";
            },
          },
        }),
      ).rejects.toThrow("requester identity changed");
      expect(writerBusy(f.sourcePath)).toBe(false);
    } finally {
      f.client.authenticatedUserId = originalUser;
    }
    const listed = await f.invoke<{ cards: unknown[] }>("workboard.cards.list", {});
    expect(listed.cards).toEqual([]);
  });
});

it.each(["principal", "profile", "permission", "topic-tenant"] as const)(
  "rolls back actual card COMMIT when %s authority retires",
  async (kind) => {
    await withSourceGateway(async (f) => {
      const observer = observeSqliteWorkerAdmissionForTest();
      let refused = false;
      const originalUser = f.client.authenticatedUserId;
      const originalProfile = f.client.authenticatedUserProfile;
      const source = {
        ...f.source,
        assertCurrent() {
          if (
            !refused &&
            observer.currentRequest?.stage === "commit" &&
            writerBusy(f.destinationPath)
          ) {
            refused = true;
            if (kind === "principal") {
              f.client.authenticatedUserId = "foreign-principal";
            } else if (kind === "profile") {
              f.client.authenticatedUserProfile = {
                ...originalProfile!,
                profileId: "foreign-profile",
              };
            } else if (kind === "permission") {
              f.readPolicy.others = "none";
            } else {
              throw new Error("Fictional Topic tenant authority retired");
            }
          }
          if (kind === "topic-tenant" && refused) {
            throw new Error("Fictional Topic tenant authority retired");
          }
        },
      };
      try {
        await expect(
          f.invoke("workboard.cards.create", f.input, { sessionTranscriptSource: source }),
        ).rejects.toThrow();
        expect(refused).toBe(true);
        expect(writerBusy(f.sourcePath)).toBe(false);
        f.client.authenticatedUserId = originalUser;
        f.client.authenticatedUserProfile = originalProfile;
        f.readPolicy.others = "view";
        const listed = await f.invoke<{ cards: unknown[] }>("workboard.cards.list", {});
        expect(listed.cards).toEqual([]);
      } finally {
        observer.restore();
      }
    });
  },
);

it("refuses missing read access, incognito, mismatched source binding and serialized authority before a card is written", async () => {
  await withSourceGateway(async (f) => {
    f.readPolicy.others = "none";
    await expect(
      f.invoke("workboard.cards.create", f.input, { sessionTranscriptSource: f.source }),
    ).rejects.toThrow();
    f.readPolicy.others = "view";
    for (const patch of [
      { sessionKey: "agent:main:dashboard:incognito-source" },
      { sessionId: "wrong-incarnation" },
      { agentId: "foreign" },
      { generation: "retired" },
      { digest: `sha256-public-message-v1:${"0".repeat(64)}` },
    ]) {
      await expect(
        f.invoke("workboard.cards.create", f.input, {
          sessionTranscriptSource: { ...f.source, selection: { ...f.source.selection, ...patch } },
        }),
      ).rejects.toThrow();
    }
    await expect(
      f.invoke("workboard.cards.list", {}, { sessionTranscriptSource: f.source }),
    ).rejects.toThrow("only supports");
    await expect(
      f.invoke("workboard.cards.create", f.input, {
        sessionTranscriptSource: JSON.parse('{"selection":{},"assertCurrent":true}'),
      }),
    ).rejects.toThrow("captured authority");
    let asyncCalls = 0;
    await expect(
      f.invoke("workboard.cards.create", f.input, {
        sessionTranscriptSource: {
          ...f.source,
          async assertCurrent() {
            asyncCalls += 1;
          },
        },
      }),
    ).rejects.toThrow("synchronous captured authority");
    expect(asyncCalls).toBe(0);
    await expect(
      f.invoke("workboard.cards.create", f.input, {
        sessionTranscriptSource: {
          ...f.source,
          assertCurrent: () => Promise.reject(new Error("Invalid async guard")),
        },
      }),
    ).rejects.toThrow("synchronous captured authority");
    const originalInternal = f.client.internal;
    f.client.internal = { ...originalInternal, syntheticClient: true };
    try {
      await expect(
        f.invoke("workboard.cards.create", f.input, { sessionTranscriptSource: f.source }),
      ).rejects.toThrow();
    } finally {
      f.client.internal = originalInternal;
    }
    await expect(
      f.invoke("workboard.cards.create", { ...f.input, sourceAdmission: { close: true } }),
    ).rejects.toThrow("request JSON");
    const listed = await f.invoke<{ cards: unknown[] }>("workboard.cards.list", {});
    expect(listed.cards).toEqual([]);
  });
});

it("refuses a Session reset after native preparation and consumes transfer only once", async () => {
  await withSourceGateway(async (f) => {
    let take: GatewayRequestHandlerOptions["takeSessionTranscriptSourceAdmission"];
    f.beforeHandler(async (request) => {
      take = request.takeSessionTranscriptSourceAdmission;
      take?.();
    });
    await expect(
      f.invoke("workboard.cards.create", f.input, { sessionTranscriptSource: f.source }),
    ).rejects.toThrow("already transferred");
    expect(() => take?.()).toThrow();
    f.beforeHandler(async () => {
      await patchSessionEntry({ ...f.sourceScope, update: () => ({ sessionId: "reset-source" }) });
    });
    await expect(
      f.invoke("workboard.cards.create", f.input, { sessionTranscriptSource: f.source }),
    ).rejects.toThrow();
    f.beforeHandler();
    const listed = await f.invoke<{ cards: unknown[] }>("workboard.cards.list", {});
    expect(listed.cards).toEqual([]);
    expect(writerBusy(f.sourcePath)).toBe(false);
  });
});

it("joins source cleanup after accepted response loss and reconciles a fresh native idempotent replay", async () => {
  await withSourceGateway(async (f) => {
    await expect(f.loseResponse()).rejects.toThrow("Fictional response lost");
    expect(writerBusy(f.sourcePath)).toBe(false);
    const listed = await f.invoke<{ cards: Array<{ id: string }> }>("workboard.cards.list", {});
    expect(listed.cards).toHaveLength(1);
    const replay = await f.invoke<{ card: { id: string } }>("workboard.cards.create", f.input, {
      sessionTranscriptSource: f.source,
    });
    expect(replay.card.id).toBe(listed.cards[0]?.id);
  });
});

it.each(["entitled", "allowlisted"] as const)(
  "carries external %s public dispatch custody through actual card COMMIT",
  async (admission) => {
    await withSourceGateway(async (f) => {
      const observer = observeSqliteWorkerAdmissionForTest();
      const stages = new Set<string>();
      const options: RuntimeGatewayRequestOptions = {
        sessionTranscriptSource: {
          ...f.source,
          assertCurrent() {
            options.sessionTranscriptSource = undefined;
            const stage = observer.currentRequest?.stage;
            if ((stage === "transaction" || stage === "commit") && writerBusy(f.destinationPath)) {
              stages.add(stage);
              expect(writerBusy(f.sourcePath)).toBe(true);
            }
          },
        },
      };
      try {
        const created = await f.publicInvoke<{ card: { id: string } }>(
          "workboard.cards.create",
          f.input,
          options,
          admission,
        );
        expect(created.card.id).toBeTruthy();
        expect(stages).toEqual(new Set(["transaction", "commit"]));
        expect(writerBusy(f.sourcePath)).toBe(false);
      } finally {
        observer.restore();
      }
    });
  },
);

it.each(["first-callback", "commit", "read-permission", "entitlement"] as const)(
  "refuses external public source dispatch when %s authority changes",
  async (retirement) => {
    await withSourceGateway(async (f) => {
      const observer = observeSqliteWorkerAdmissionForTest();
      const originalUser = f.client.authenticatedUserId;
      let retired = false;
      try {
        await expect(
          f.publicInvoke("workboard.cards.create", f.input, {
            sessionTranscriptSource: {
              ...f.source,
              assertCurrent() {
                if (
                  retirement === "first-callback" ||
                  (observer.currentRequest?.stage === "commit" && writerBusy(f.destinationPath))
                ) {
                  retired = true;
                  if (retirement === "entitlement") {
                    const scope = f.publicScope();
                    if (!scope) {
                      throw new Error("External request scope is unavailable");
                    }
                    scope.gatewayMethodDispatchAllowed = false;
                  } else if (retirement === "read-permission") {
                    f.readPolicy.others = "none";
                  } else {
                    f.client.authenticatedUserId = "foreign-public-dispatch-principal";
                  }
                }
              },
            },
          }),
        ).rejects.toThrow();
        expect(retired).toBe(true);
      } finally {
        f.client.authenticatedUserId = originalUser;
        f.readPolicy.others = "view";
        observer.restore();
      }
      const listed = await f.invoke<{ cards: unknown[] }>("workboard.cards.list", {});
      expect(listed.cards).toEqual([]);
      expect(writerBusy(f.sourcePath)).toBe(false);
    });
  },
);

it.each(["denied", "missing-client"] as const)(
  "refuses external public source dispatch without %s entitlement or authenticated client",
  async (admission) => {
    await withSourceGateway(async (f) => {
      let guardCalls = 0;
      await expect(
        f.publicInvoke(
          "workboard.cards.create",
          f.input,
          {
            sessionTranscriptSource: {
              ...f.source,
              assertCurrent() {
                guardCalls += 1;
              },
            },
          },
          admission,
        ),
      ).rejects.toThrow();
      expect(guardCalls).toBe(0);
      const listed = await f.invoke<{ cards: unknown[] }>("workboard.cards.list", {});
      expect(listed.cards).toEqual([]);
    });
  },
);

it("refuses a source-bound external call outside the exact admitted method allowlist", async () => {
  await withSourceGateway(async (f) => {
    let guardCalls = 0;
    await expect(
      f.publicInvoke(
        "workboard.cards.list",
        {},
        {
          sessionTranscriptSource: {
            ...f.source,
            assertCurrent() {
              guardCalls += 1;
            },
          },
        },
        "allowlisted",
      ),
    ).rejects.toThrow("exact allowlist");
    expect(guardCalls).toBe(0);
  });
});
it.each(["source-option", "selection", "guard"] as const)(
  "refuses external %s getters that replace the original connection before source capture",
  async (getter) => {
    await withSourceGateway(async (f) => {
      const originalConn = f.client.connId;
      let getterCalls = 0;
      let guardCalls = 0;
      const replaceConnection = () => {
        getterCalls += 1;
        f.client.connId = "same-authorized-user-different-connection";
      };
      const source: SessionTranscriptGatewaySource = {
        get selection() {
          if (getter === "selection") {
            replaceConnection();
          }
          return f.source.selection;
        },
        get assertCurrent() {
          if (getter === "guard") {
            replaceConnection();
          }
          return () => {
            guardCalls += 1;
          };
        },
      };
      const options: RuntimeGatewayRequestOptions = {
        get sessionTranscriptSource() {
          if (getter === "source-option") {
            replaceConnection();
          }
          return source;
        },
      };
      try {
        await expect(f.publicInvoke("workboard.cards.create", f.input, options)).rejects.toThrow(
          "originating requester changed",
        );
        expect(getterCalls).toBeGreaterThan(0);
        expect(guardCalls).toBe(0);
      } finally {
        f.client.connId = originalConn;
      }
      const listed = await f.invoke<{ cards: unknown[] }>("workboard.cards.list", {});
      expect(listed.cards).toEqual([]);
      expect(writerBusy(f.sourcePath)).toBe(false);
    });
  },
);

it.each(["first-callback", "commit"] as const)(
  "retains the original external scoped authority when a %s callback replaces it",
  async (retirement) => {
    await withSourceGateway(async (f) => {
      const observer = observeSqliteWorkerAdmissionForTest();
      let replaced = false;
      try {
        await expect(
          f.publicInvoke("workboard.cards.create", f.input, {
            sessionTranscriptSource: {
              ...f.source,
              assertCurrent() {
                if (
                  retirement === "first-callback" ||
                  (observer.currentRequest?.stage === "commit" && writerBusy(f.destinationPath))
                ) {
                  const scope = f.publicScope();
                  if (!scope) {
                    throw new Error("External request scope is unavailable");
                  }
                  f.retirePublicAuthority();
                  scope.hasCurrentClientAuthority = () => true;
                  replaced = true;
                }
              },
            },
          }),
        ).rejects.toThrow();
        expect(replaced).toBe(true);
      } finally {
        observer.restore();
      }
      const listed = await f.invoke<{ cards: unknown[] }>("workboard.cards.list", {});
      expect(listed.cards).toEqual([]);
      expect(writerBusy(f.sourcePath)).toBe(false);
    });
  },
);
