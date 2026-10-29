import "server-only";
import { openConfiguredDb, type Db } from "./client";

// One database handle per server process, kept on globalThis so dev-mode
// hot reloads do not open the same data directory twice.
const g = globalThis as unknown as { __hiddenlotDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  // A failed open (say, the hosted database is briefly unreachable) is not cached.
  g.__hiddenlotDb ??= openConfiguredDb().catch((err) => {
    g.__hiddenlotDb = undefined;
    throw err;
  });
  return g.__hiddenlotDb;
}
