import path from "node:path";
import { fileURLToPath } from "node:url";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import workboard from "../../../extensions/workboard/index.js";
import { createTestPluginApi } from "../../plugin-sdk/plugin-test-api.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "../server-methods/types.js";

const methods = new Map<string, GatewayRequestHandler>();
const disposals: Array<() => void | Promise<void>> = [];
let current = true;
let lockDatabase: ReturnType<typeof openNodeSqliteDatabase> | undefined;
workboard.register(
  createTestPluginApi({
    runtimeSource: fileURLToPath(
      new URL("../../../extensions/workboard/index.ts", import.meta.url),
    ),
    registerGatewayMethod(name, handler) {
      methods.set(name, handler);
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
  let response: unknown;
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
await invoke("workboard.cards.list", {});
process.send?.({ ready: true, pid: process.pid });
