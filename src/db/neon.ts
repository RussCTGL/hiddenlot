import { Client, neon } from "@neondatabase/serverless";
import { migrate, type Db, type Sql } from "./client";

// Hosted Postgres on Neon, for serverless deployments. A single query is one
// HTTPS request, so there is no connection to keep between requests. A
// transaction needs one session: it opens a WebSocket client for its own
// duration and always closes it, which is what serverless functions require.

// node-postgres sends a Buffer as bytea but would JSON-encode a plain Uint8Array.
const param = (v: unknown) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);

export function neonDb(url: string): Db {
  const http = neon(url);
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await http.query(sql, params.map(param))) as T[];
    },
    async transaction(fn) {
      const client = new Client(url);
      await client.connect();
      const tx: Sql = {
        async query<T>(sql: string, params: unknown[] = []) {
          return (await client.query(sql, params.map(param))).rows as T[];
        },
      };
      try {
        await client.query("BEGIN");
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        await client.end();
      }
    },
    close: async () => {},
  };
}

/** Opens the hosted database and applies pending migrations. */
export async function openNeonDb(url: string): Promise<Db> {
  const db = neonDb(url);
  await migrate(db);
  return db;
}
