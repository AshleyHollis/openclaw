import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export async function createSqliteSnapshot(
  sourcePath: string,
  targetPath: string,
): Promise<number> {
  await fs.rm(targetPath, { force: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec("PRAGMA busy_timeout = 30000;");
    const userVersion = readSqliteUserVersion(source);
    source.prepare("VACUUM INTO ?").run(targetPath);
    await fs.chmod(targetPath, 0o600);
    return userVersion;
  } finally {
    source.close();
  }
}

export function verifySqliteDatabase(databasePath: string): readonly string[] {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check;").all() as Array<{ integrity_check: string }>;
    const messages = rows.map((row) => row.integrity_check);
    if (messages.length !== 1 || messages[0] !== "ok") {
      throw new Error(`SQLite integrity check failed for ${databasePath}: ${messages.join("; ")}`);
    }
    return messages;
  } finally {
    db.close();
  }
}

function readSqliteUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version;").get() as { user_version: number | bigint };
  const value = row.user_version;
  return typeof value === "bigint" ? Number(value) : value;
}
