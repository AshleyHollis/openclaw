import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { collectKyselyGuardrailViolations } from "../../scripts/check-kysely-guardrails.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function violations(relativePath: string, content: string) {
  return collectKyselyGuardrailViolations(
    parser.parseSourceFile(relativePath, content),
    relativePath,
  );
}

describe("Kysely raw SQLite ownership guard", () => {
  it("admits the actual contentless exclusive-lock coordinator", () => {
    const relativePath = "src/infra/sqlite-coordinator.ts";
    const content = fs.readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
    expect(violations(relativePath, content)).toEqual([]);
  });

  it.each(["src/infra/sqlite-snapshot-staging.ts", "src/infra/sqlite-coordinator-store.ts"])(
    "rejects raw state access outside the lock primitive in %s",
    (relativePath) => {
      expect(
        violations(
          relativePath,
          `import type { DatabaseSync } from "node:sqlite";
declare const database: DatabaseSync;
database.exec("CREATE TABLE state(value TEXT)");
database.prepare("SELECT value FROM state");`,
        ),
      ).toEqual([
        {
          line: 3,
          message:
            "new raw node:sqlite access requires Kysely or an explicit raw SQLite allowlist entry",
        },
        {
          line: 4,
          message:
            "new raw node:sqlite access requires Kysely or an explicit raw SQLite allowlist entry",
        },
      ]);
    },
  );
});
