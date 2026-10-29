import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";

// Database access. Locally this is PGlite (Postgres compiled to WASM, stored
// under .data/); with DATABASE_URL set it is hosted Postgres on Neon over
// HTTPS (./neon.ts). The SQL in db/migrations is plain Postgres for both.
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
  return db.transaction(async (tx) => {
    // Several server instances can start at once on a hosted database; they take turns.
    await tx.query(`SELECT pg_advisory_xact_lock(7701)`);
    await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await tx.query<{ name: string }>(`SELECT name FROM schema_migrations`)).map((r) => r.name));
    const applied: string[] = [];
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue;
      // One statement per query (PGlite's extended protocol); split on ';' at line ends.
      for (const stmt of splitStatements(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"))) await tx.query(stmt);
      await tx.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
      applied.push(file);
    }
    return applied;
  });
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

/** Opens an embedded database. `dataDir: null` gives an in-memory database (tests). */
export async function openDb(dataDir: string | null): Promise<Db> {
  if (dataDir !== null) mkdirSync(path.dirname(dataDir), { recursive: true });
  // Loaded only here, so a hosted deployment never starts the WASM database.
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = dataDir === null ? await PGlite.create() : await PGlite.create(dataDir);
  const db = wrap(pg);
  await migrate(db);
  return db;
}

export const DEFAULT_DATA_DIR = path.join(process.cwd(), ".data", "pglite");

/** The app's database: hosted Postgres when DATABASE_URL is set, else the embedded one. */
export async function openConfiguredDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) return (await import("./neon")).openNeonDb(url);
  return openDb(process.env.HIDDENLOT_DB_DIR || DEFAULT_DATA_DIR);
}
