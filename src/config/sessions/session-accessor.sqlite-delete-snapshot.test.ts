import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { readSessionGenerationIdsForKeys } from "./session-accessor.sqlite-delete-snapshot.js";

it("preserves stored generation identities and exact-key selection in the read kernel", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE session_windows (session_key TEXT, session_id TEXT)");
    const insert = db.prepare("INSERT INTO session_windows VALUES (?, ?)");
    insert.run("room", " current ");
    insert.run("room", "retained");
    insert.run("\troom ", "exact-stored");
    insert.run("Room", "different-key");

    expect(new Set(readSessionGenerationIdsForKeys({ db }, ["\troom ", " room "]))).toEqual(
      new Set([" current ", "retained"]),
    );
    expect(readSessionGenerationIdsForKeys({ db }, ["\troom "], { exactStoredKeys: true })).toEqual(
      ["exact-stored"],
    );
    expect(readSessionGenerationIdsForKeys({ db }, [])).toEqual([]);
    expect(db.prepare("SELECT count(*) AS count FROM session_windows").get()?.count).toBe(4);
  } finally {
    db.close();
  }
});
