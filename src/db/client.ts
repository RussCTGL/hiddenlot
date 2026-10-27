import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// Database access. Locally this is PGlite (Postgres compiled to WASM, stored
// under .data/), so the SQL in db/migrations is plain Postgres and can run
// unchanged on a hosted Postgres for deployment.
//
// Every query goes through the server; there is no client-side database key.

export interface Sql {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

function wrap(pg: PGlite): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await pg.query<T>(sql, params)).rows;
    },
    transaction(fn) {
      return pg.transaction((tx) =>
        fn({
          async query<T>(sql: string, params: unknown[] = []) {
            return (await tx.query<T>(sql, params)).rows;
          },
        }),
      );
    },
    close: () => pg.close(),
  };
}

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>(`SELECT name FROM schema_migrations`)).map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await db.transaction(async (tx) => {
      // PGlite's extended protocol takes one statement per query; split on ';' at line ends.
      for (const stmt of splitStatements(sql)) await tx.query(stmt);
      await tx.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
    });
    applied.push(file);
  }
  return applied;
}

export function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Opens a database. `dataDir: null` gives an in-memory database (tests). */
export async function openDb(dataDir: string | null): Promise<Db> {
  if (dataDir !== null) mkdirSync(path.dirname(dataDir), { recursive: true });
  const pg = dataDir === null ? await PGlite.create() : await PGlite.create(dataDir);
  const db = wrap(pg);
  await migrate(db);
  return db;
}

export const DEFAULT_DATA_DIR = path.join(process.cwd(), ".data", "pglite");
