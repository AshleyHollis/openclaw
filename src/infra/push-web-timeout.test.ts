// Proves a real web-push HTTPS request is destroyed at the host transport deadline.
import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { registerWebPushSubscription, sendWebPushNotification } from "./push-web.js";

const stateDirs: string[] = [];
const stalledServers: Array<ReturnType<typeof createStalledTlsServer>> = [];

async function stateDir(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "openclaw-push-web-timeout-"));
  stateDirs.push(value);
  return value;
}

function createStalledTlsServer() {
  const sockets = new Set<net.Socket>();
  let listening = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    server,
    sockets,
    async listen(): Promise<number> {
      return await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("stalled TLS server address unavailable"));
            return;
          }
          listening = true;
          resolve(address.port);
        });
      });
    },
    async stop(): Promise<void> {
      if (!listening) {
        return;
      }
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function settleWithin<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Web Push request did not terminate")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

afterEach(async () => {
  await Promise.all(stalledServers.splice(0).map((server) => server.stop()));
  closeOpenClawStateDatabase();
  await Promise.all(stateDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Web Push transport deadline", () => {
  it("destroys a stalled underlying HTTPS request at the host deadline", async () => {
    const server = createStalledTlsServer();
    stalledServers.push(server);
    const port = await server.listen();
    const dir = await stateDir();
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const subscription = await registerWebPushSubscription({
      endpoint: `https://127.0.0.1:${port}/stalled`,
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
      baseDir: dir,
    });

    await expect(
      settleWithin(
        sendWebPushNotification({
          subscriptionId: subscription.subscriptionId,
          payload: { title: "Deadline" },
          timeoutMs: 100,
          baseDir: dir,
        }),
        2_000,
      ),
    ).resolves.toMatchObject({ ok: false, error: "Socket timeout" });
  });
});
