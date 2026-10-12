import path from "node:path";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { createTestPluginApi } from "../../plugin-sdk/plugin-test-api.js";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "../../plugins/plugin-registration.types.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../../test-utils/bundled-plugin-public-surface.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "../server-methods/types.js";

const methods = new Map<string, GatewayRequestHandler>();
const disposals: Array<() => void | Promise<void>> = [];
let changeService: OpenClawPluginService | undefined;
const cardPublications = new Map<number, number>();
const publicationReads = new Set<Promise<void>>();
let current = true;
let lockDatabase: ReturnType<typeof openNodeSqliteDatabase> | undefined;
const { default: workboard } = await loadBundledPluginFacade<{
  default: { register(api: ReturnType<typeof createTestPluginApi>): void };
}>({ pluginId: "workboard", artifactBasename: "index.js" });
workboard.register(
  createTestPluginApi({
    runtimeSource: resolveBundledPluginPublicModulePath({
      pluginId: "workboard",
      artifactBasename: "index.js",
    }),
    registerGatewayMethod(name, handler) {
      methods.set(name, handler);
    },
    registerService(service) {
      if (service.id === "workboard-change-events" && service.apiVersion !== 2) {
        changeService = service;
      }
    },
    registerRuntimeLifecycle(lifecycle) {
      if (lifecycle.dispose) {
        disposals.push(lifecycle.dispose);
      }
    },
  }),
);

async function invoke(
  method: string,
  params: Record<string, unknown>,
  loseResponse = false,
  notifyDispatch?: number,
) {
  const handler = methods.get(method);
  if (!handler) {
    throw new Error(`unregistered method: ${method}`);
  }
  let response: { ok: boolean; payload: unknown; error: unknown } | undefined;
  let checks = 0;
  await handler({
    req: { type: "req", id: "fictional-create", method, params },
    params,
    client: { connect: { role: "operator", scopes: ["operator.read", "operator.write"] } },
    context: { getRuntimeConfig: () => ({}) },
    sessionMutationAuthorization: {
      assertCurrent() {
        if (!current) {
          throw new Error("fictional caller authority changed");
        }
        checks += 1;
        // Client serialization and the two native dispatch checks precede the
        // worker post. The next event turn observes that synchronous post complete.
        if (notifyDispatch !== undefined && checks === 3) {
          setImmediate(() => process.send?.({ dispatched: notifyDispatch }));
        }
      },
    },
    respond(ok, payload, error) {
      if (loseResponse && ok) {
        throw new Error("fictional response lost");
      }
      response = { ok, payload, error };
    },
  } as GatewayRequestHandlerOptions);
  return response;
}

// Only the registered external-change owner runs; other background producers stay idle.
const serviceContext = {
  config: {},
  stateDir: process.env.OPENCLAW_STATE_DIR!,
  logger: { debug() {}, info() {}, warn: console.error, error: console.error },
  gatewayEvents: {
    emit(event) {
      if (event !== "changed" || cardPublications.size === 0) {
        return;
      }
      const publication = publishCards()
        .catch((error: unknown) => {
          for (const id of cardPublications.keys()) {
            process.send?.({ id, thrown: String(error) });
          }
          cardPublications.clear();
        })
        .finally(() => publicationReads.delete(publication));
      publicationReads.add(publication);
    },
    onSessionsChanged: () => () => {},
  },
} satisfies OpenClawPluginServiceContext;

async function publishCards() {
  const response = await invoke("workboard.cards.list", {});
  const payload = response?.payload;
  if (
    !response?.ok ||
    typeof payload !== "object" ||
    payload === null ||
    !("cards" in payload) ||
    !Array.isArray(payload.cards)
  ) {
    throw new Error("Workboard change publication did not produce a successful card list.");
  }
  for (const [id, count] of cardPublications) {
    if (payload.cards.length === count) {
      cardPublications.delete(id);
      process.send?.({ id, response });
    }
  }
}

process.on(
  "message",
  (message: {
    id: number;
    method: string;
    params: Record<string, unknown>;
    loseResponse?: boolean;
    notifyDispatch?: boolean;
  }) => {
    void (async () => {
      try {
        if (message.method === "watch-cards") {
          const count = message.params.count;
          if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
            throw new Error("Card publication requires an exact nonnegative count.");
          }
          cardPublications.set(message.id, count);
          process.send?.({ watching: message.id });
          return;
        }
        if (message.method === "hold-lock") {
          lockDatabase = openNodeSqliteDatabase(
            path.join(process.env.OPENCLAW_STATE_DIR!, "plugins", "workboard", "workboard.sqlite"),
          );
          lockDatabase.exec("BEGIN IMMEDIATE");
          process.send?.({ id: message.id, locked: true });
          return;
        }
        if (message.method === "release-lock") {
          lockDatabase!.exec("ROLLBACK");
          lockDatabase!.close();
          lockDatabase = undefined;
          process.send?.({ id: message.id, released: true });
          return;
        }
        if (message.method === "revoke" || message.method === "restore") {
          current = message.method === "restore";
          process.send?.({ id: message.id, current });
          return;
        }
        if (message.method === "stop") {
          if (lockDatabase) {
            lockDatabase.exec("ROLLBACK");
            lockDatabase.close();
            lockDatabase = undefined;
          }
          await changeService?.stop?.(serviceContext);
          await Promise.all(publicationReads);
          await Promise.all(disposals.map(async (dispose) => await dispose()));
          process.send?.({ id: message.id, stopped: true });
          process.disconnect?.();
          return;
        }
        process.send?.({
          id: message.id,
          response: await invoke(
            message.method,
            message.params,
            message.loseResponse,
            message.notifyDispatch ? message.id : undefined,
          ),
        });
      } catch (error) {
        process.send?.({
          id: message.id,
          thrown: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  },
);
if (!changeService) {
  throw new Error("Workboard external-change service was not registered.");
}
await changeService.start(serviceContext);
await invoke("workboard.cards.list", {});
process.send?.({ ready: true, pid: process.pid });
