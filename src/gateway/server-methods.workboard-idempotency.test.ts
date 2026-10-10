import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

type Reply = {
  dispatched?: number;
  ready?: boolean;
  pid?: number;
  id?: number;
  thrown?: string;
  response?: {
    ok: boolean;
    payload?: {
      card?: { id: string; title: string; status: string; updatedAt: number };
      cards?: unknown[];
    };
    error?: { message: string };
  };
};

let stateDir: string;
const children: ChildProcess[] = [];
let nextId = 0;
async function start() {
  const child = fork(
    fileURLToPath(
      new URL("./test-fixtures/workboard-idempotency-child.test-support.ts", import.meta.url),
    ),
    [],
    {
      execArgv: ["--import", new URL("../../scripts/tsx.mjs", import.meta.url).href],
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  children.push(child);
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => {
    diagnostics += String(chunk);
  });
  child.stdout?.on("data", (chunk) => {
    diagnostics += String(chunk);
  });
  const pending = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void }>();
  const dispatched = new Map<number, () => void>();
  await new Promise<void>((resolve, reject) => {
    child.on("message", (reply: Reply) => {
      if (reply.dispatched !== undefined) {
        dispatched.get(reply.dispatched)?.();
        dispatched.delete(reply.dispatched);
      }
      if (reply.ready) {
        resolve();
      }
      if (reply.id !== undefined) {
        pending.get(reply.id)?.resolve(reply);
        pending.delete(reply.id);
      }
    });
    child.once("exit", (code) => {
      const error = new Error(`native fixture exited ${code}: ${diagnostics}`);
      reject(error);
      for (const operation of pending.values()) {
        operation.reject(error);
      }
    });
  });
  return {
    pid: child.pid,
    call(method: string, params: Record<string, unknown> = {}, loseResponse = false) {
      const id = ++nextId;
      return new Promise<Reply>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ id, method, params, loseResponse });
      });
    },
    startContended(method: string, params: Record<string, unknown>) {
      const id = ++nextId;
      const posted = new Promise<void>((resolve) => {
        dispatched.set(id, resolve);
      });
      const result = new Promise<Reply>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ id, method, params, notifyDispatch: true });
      });
      return { posted, result };
    },
    async stop() {
      const exited = once(child, "exit");
      await this.call("stop");
      await exited;
    },
  };
}
let first: Awaited<ReturnType<typeof start>>;
let second: Awaited<ReturnType<typeof start>>;
beforeAll(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-workboard-idempotency-"));
  [first, second] = await Promise.all([start(), start()]);
});
it("admits one immutable scoped create across real processes, restart, and response loss", async () => {
  expect(first.pid).not.toBe(second.pid);
  const input = {
    title: "Fictional invoice commitment",
    tenant: "fictional-intake",
    boardId: "default",
    idempotencyKey: "fictional-operation-1",
    notes: "Review the fictional source",
    labels: ["email"],
  };
  const [left, right] = await Promise.all([
    first.call("workboard.cards.create", input),
    second.call("workboard.cards.create", input),
  ]);

  expect(left.response?.ok).toBe(true);
  expect(right.response?.ok).toBe(true);
  const card = left.response!.payload!.card!;
  expect(right.response!.payload!.card!.id).toBe(card.id);
  expect((await first.call("workboard.cards.list")).response?.payload?.cards).toHaveLength(1);
  for (const [method, params] of [
    ["create", { ...input, idempotencyKey: "revoked-operation" }],
    ["update", { id: card.id, expectedUpdatedAt: card.updatedAt, patch: { status: "done" } }],
  ] as const) {
    await first.call("hold-lock");
    const contended = second.startContended(`workboard.cards.${method}`, params);
    await contended.posted;
    await second.call("revoke");
    await first.call("release-lock");
    const refusedAfterDispatch = await contended.result;
    expect(refusedAfterDispatch.response?.ok).toBe(false);
    expect(refusedAfterDispatch.response?.error?.message).toContain("authority changed");
    await second.call("restore");
    expect((await first.call("workboard.cards.list")).response?.payload?.cards).toEqual([card]);
  }
  for (const patch of [
    { title: "Changed intent" },
    { notes: "Changed source" },
    { labels: ["changed"] },
    { status: "done" },
    { agentId: "different-agent" },
    { metadata: { templateId: "changed" } },
  ]) {
    const refused = await second.call("workboard.cards.create", { ...input, ...patch });
    expect(refused.response?.ok).toBe(false);
    expect(refused.response?.error?.message).toContain("immutable intent changed");
  }
  expect(
    (await second.call("workboard.cards.create", { ...input, tenant: "another-tenant" })).response
      ?.ok,
  ).toBe(true);
  expect(
    (await second.call("workboard.cards.create", { ...input, boardId: "another-board" })).response
      ?.ok,
  ).toBe(true);
  await first.call("workboard.cards.update", {
    id: card.id,
    patch: { status: "done", title: "Handled fictional commitment" },
  });
  expect(
    (await second.call("workboard.cards.create", input)).response?.payload?.card,
  ).toMatchObject({ id: card.id, status: "done", title: "Handled fictional commitment" });
  const lostInput = { ...input, idempotencyKey: "fictional-lost-response" };
  const lostResponse = await first.call("workboard.cards.create", lostInput, true);
  expect(lostResponse.response?.ok).toBe(false);
  expect(lostResponse.response?.error?.message).toContain("fictional response lost");
  const settled = await second.call("workboard.cards.create", lostInput);
  expect(settled.response?.ok).toBe(true);
  await first.stop();
  const restarted = await start();
  expect(
    (await restarted.call("workboard.cards.create", lostInput)).response?.payload?.card?.id,
  ).toBe(settled.response?.payload?.card?.id);
  expect((await restarted.call("workboard.cards.list")).response?.payload?.cards).toHaveLength(4);
  await Promise.all([second.stop(), restarted.stop()]);
});
afterAll(async () => {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }),
  );
  if (stateDir) {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
