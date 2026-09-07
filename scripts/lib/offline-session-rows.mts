import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { quoteSqliteIdentifier } from "../../src/infra/sqlite-schema-sql.js";

function encodeValue(value: SQLOutputValue): unknown {
  if (value === null) {
    return ["null"];
  }
  if (value instanceof Uint8Array) {
    return ["blob", Buffer.from(value).toString("base64")];
  }
  return [typeof value, String(value)];
}

export function encodedRow(row: Record<string, SQLOutputValue>): string {
  return JSON.stringify(
    Object.keys(row)
      .toSorted()
      .map((field) => [field, encodeValue(row[field]!)]),
  );
}

export function tableRows(database: DatabaseSync, table: string) {
  const query = database.prepare(`SELECT * FROM ${quoteSqliteIdentifier(table)}`);
  query.setReadBigInts(true);
  return query.all();
}

/** Compare typed logical rows as a multiset, retaining duplicates and all columns. */
export function rowsDigest(rows: Record<string, SQLOutputValue>[]): string {
  return createHash("sha256")
    .update(JSON.stringify(rows.map(encodedRow).toSorted()))
    .digest("hex");
}
