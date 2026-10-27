import "server-only";
import { DEFAULT_DATA_DIR, openDb, type Db } from "./client";

// One database handle per server process, kept on globalThis so dev-mode
// hot reloads do not open the same data directory twice.
const g = globalThis as unknown as { __hiddenlotDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  g.__hiddenlotDb ??= openDb(process.env.HIDDENLOT_DB_DIR || DEFAULT_DATA_DIR);
  return g.__hiddenlotDb;
}
