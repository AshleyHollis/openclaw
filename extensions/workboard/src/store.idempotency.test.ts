import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { describe, expect, it } from "vitest";
import { createKernelStores } from "./test/sqlite-kernel.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";

describe("Workboard immutable scoped create admission", () => {
  it("returns the recorded result without changing history, retaining original scope through edits", async () => {
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const input = {
      title: "Fictional commitment",
      tenant: "fictional",
      boardId: "default",
      idempotencyKey: "operation",
      notes: "Fictional source",
      labels: ["email"],
    };
    const created = await store.create(input);
    await expect(store.create({ ...input })).resolves.toEqual(created);
    const handled = await store.update(created.id, {
      status: "done",
      title: "Handled",
      tenant: "edited",
      boardId: "moved",
      idempotencyKey: "edited-key",
    });
    await expect(store.create(input)).resolves.toEqual(handled);
    await expect(store.list()).resolves.toHaveLength(1);
    for (const patch of [
      { title: "Changed" },
      { notes: "Changed" },
      { status: "done" },
      { priority: "high" },
      { labels: ["changed"] },
      { agentId: "worker" },
      { sessionKey: "session" },
      { runId: "run" },
      { sourceUrl: "https://fictional.invalid/source" },
      { position: 42 },
      { startedAt: 42 },
      { completedAt: 42 },
      { metadata: { templateId: "different" } },
      { execution: { engine: "fictional" } },
      { skills: ["different"] },
      { scheduledAt: 42 },
      { maxRuntimeSeconds: 42 },
      { maxRetries: 2 },
      { workspace: { kind: "scratch" } },
    ]) {
      await expect(store.create({ ...input, ...patch })).rejects.toThrow(
        "immutable intent changed",
      );
    }
    await expect(store.get(created.id)).resolves.toEqual(handled);
  });

  it("refuses a new create when an initially missing parent appears before admission", async () => {
    let restoreParent: (() => Promise<void>) | undefined;
    const harness = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
      beforeCardWrite: async (_key, value) => {
        if (value.card.title === "Fictional child" && restoreParent) {
          const restore = restoreParent;
          restoreParent = undefined;
          await restore();
        }
      },
    });
    const parent = await harness.store.create({ title: "Fictional parent" });
    await harness.store.delete(parent.id);
    restoreParent = async () =>
      await harness.stores.cards.register(parent.id, { version: 1, card: parent });
    await expect(
      harness.store.create({
        title: "Fictional child",
        parents: [parent.id],
        idempotencyKey: "parent-race",
      }),
    ).rejects.toThrow(`card not found: ${parent.id}`);
    await expect(harness.store.list()).resolves.toEqual([parent]);
  });

  it("refuses legacy duplicates and unproven intent without modifying or guessing their rows", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    const first = await store.create({ title: "First legacy commitment" });
    const second = await store.create({ title: "Second legacy commitment" });
    const automation = { tenant: "legacy", boardId: "default", idempotencyKey: "legacy-operation" };
    await stores.cards.register(first.id, {
      version: 1,
      card: { ...first, metadata: { automation } },
    });
    await expect(store.create({ title: first.title, ...automation })).rejects.toThrow(
      "legacy original intent is unproven",
    );
    await stores.cards.register(second.id, {
      version: 1,
      card: { ...second, metadata: { automation } },
    });
    const before = await store.list();
    await expect(store.create({ title: first.title, ...automation })).rejects.toThrow(
      "legacy duplicate scope requires repair",
    );
    await expect(store.list()).resolves.toEqual(before);
    await expect(
      store.create({ title: "Different tenant", ...automation, tenant: "another" }),
    ).resolves.toMatchObject({ title: "Different tenant" });
    await expect(
      store.create({ title: "Different board", ...automation, boardId: "another" }),
    ).resolves.toMatchObject({ title: "Different board" });
  });

  it("admits schema-v3 cards without inventing creation intent during migration", async () => {
    const harness = createWorkboardSqliteTestHarness({ createStores: createKernelStores });
    const legacy = await harness.store.create({ title: "Fictional v3 card" });
    await harness.store.close();
    const db = openNodeSqliteDatabase(harness.dbPath);
    try {
      db.exec("DROP INDEX workboard_cards_creation_idempotency_idx");
      for (const column of [
        "creation_idempotency_key",
        "creation_tenant",
        "creation_board_id",
        "creation_intent_json",
      ]) {
        db.exec(`ALTER TABLE workboard_cards DROP COLUMN ${column}`);
      }
      db.exec("DELETE FROM workboard_schema_migrations WHERE id IN ('schema-4', 'schema-5')");
      db.prepare(
        "INSERT OR IGNORE INTO workboard_schema_migrations (id, applied_at) VALUES ('schema-3', ?)",
      ).run(Date.now());
      expect(
        db
          .prepare("SELECT 1 AS found FROM workboard_schema_migrations WHERE id = 'schema-5'")
          .get(),
      ).toBeUndefined();
      const remainingColumns = db.prepare("PRAGMA table_info(workboard_cards)").all();
      for (const column of [
        "creation_idempotency_key",
        "creation_tenant",
        "creation_board_id",
        "creation_intent_json",
      ]) {
        expect(remainingColumns.map((row) => row.name)).not.toContain(column);
      }
    } finally {
      db.close();
    }
    const reopened = createKernelStores(harness.dbPath);
    try {
      const migrated = openNodeSqliteDatabase(harness.dbPath);
      try {
        expect(
          migrated
            .prepare("SELECT 1 AS found FROM workboard_schema_migrations WHERE id = 'schema-5'")
            .get(),
        ).toEqual({ found: 1 });
      } finally {
        migrated.close();
      }
      expect((await reopened.cards.lookup(legacy.id))?.card).toEqual(legacy);
      const scoped = { ...legacy, metadata: { automation: { idempotencyKey: "new-admission" } } };
      await expect(
        reopened.cards.registerIdempotent(legacy.id, { version: 1, card: scoped }, "original", []),
      ).rejects.toThrow("card identity is already occupied");
      await expect(reopened.cards.lookup(legacy.id)).resolves.toMatchObject({ card: legacy });
    } finally {
      await reopened.close();
    }
  });
});
