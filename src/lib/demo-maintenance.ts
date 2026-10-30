import "server-only";
import type { Db } from "@/db/client";
import { listNetworks } from "@/db/repo";
import { getDb } from "@/db/server";
import { seedDemo } from "@/seed/demo";

// HIDDENLOT_SEED_ON_START=true  loads the synthetic demo when the database is empty (or has no accounts yet).
// HIDDENLOT_RESEED_HOURS=24     reloads it every N hours (clears everything visitors did).
// On a serverless host the reload is a daily cron request instead (src/app/api/cron/reseed).
//
// Several server instances can share one hosted database, so seeding takes a
// lease: only one instance seeds at a time, and the others leave it alone.

export async function startDemoMaintenance() {
  const db = await getDb();
  // Empty, or loaded by a release from before sign-in accounts existed (nobody could sign in).
  const needed = async () => (await listNetworks(db)).length === 0 || (await db.query(`SELECT 1 FROM users WHERE username IS NOT NULL LIMIT 1`)).length === 0;
  if (process.env.HIDDENLOT_SEED_ON_START === "true" && (await needed())) {
    await seedUnderLease(db, needed, "seeded");
  }
  const hours = Number(process.env.HIDDENLOT_RESEED_HOURS ?? 0);
  if (hours > 0) {
    const timer = setInterval(
      () => {
        reseedDemo().catch((err) => console.error("[hiddenlot] reseed failed", err));
      },
      hours * 3_600_000,
    );
    timer.unref();
  }
}

/** Reloads the demo unless another instance is already doing it. Returns whether this call did. */
export async function reseedDemo(): Promise<boolean> {
  return seedUnderLease(await getDb(), async () => true, "reseeded");
}

/**
 * The daily reload behind the public cron route: at most once per 20 hours,
 * however often the route is called, so nobody can wipe the shared demo at will.
 */
export async function dailyReseed(): Promise<boolean> {
  const db = await getDb();
  const due = await db.query(
    `INSERT INTO maintenance_leases (name, until) VALUES ('daily-reseed', now() + interval '20 hours')
     ON CONFLICT (name) DO UPDATE SET until = EXCLUDED.until WHERE maintenance_leases.until < now()
     RETURNING name`,
  );
  return due.length > 0 && (await reseedDemo());
}

async function seedUnderLease(db: Db, stillNeeded: () => Promise<boolean>, verb: string): Promise<boolean> {
  const taken = await db.query(
    `INSERT INTO maintenance_leases (name, until) VALUES ('seed', now() + interval '10 minutes')
     ON CONFLICT (name) DO UPDATE SET until = EXCLUDED.until WHERE maintenance_leases.until < now()
     RETURNING name`,
  );
  if (taken.length === 0) return false;
  try {
    if (!(await stillNeeded())) return false; // another instance finished while this one waited
    const r = await seedDemo(db, new Date());
    console.log(`[hiddenlot] ${verb} ${r.dataset}: ${r.lots} lots, ${r.demands} demands, ${r.opportunities} opportunities`);
    return true;
  } finally {
    await db.query(`UPDATE maintenance_leases SET until = now() WHERE name = 'seed'`);
  }
}
