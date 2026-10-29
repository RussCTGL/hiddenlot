import { neon } from "@neondatabase/serverless";
import { openDb, type Db } from "@/db/client";
import { openNeonDb } from "@/db/neon";

// A fresh, empty database for one test file: in memory by default. With
// HIDDENLOT_TEST_DATABASE_URL set, the same suite runs against hosted Postgres
// instead (npm run test:hosted). That database is WIPED: use a scratch one.

export async function freshDb(): Promise<Db> {
  const url = process.env.HIDDENLOT_TEST_DATABASE_URL;
  if (!url) return openDb(null);
  const sql = neon(url);
  await sql.query("DROP SCHEMA IF EXISTS public CASCADE");
  await sql.query("CREATE SCHEMA public");
  return openNeonDb(url);
}
