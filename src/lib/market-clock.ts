import "server-only";
import { getClockOffsetHours } from "@/db/repo";
import { getDb } from "@/db/server";
import { runMarketTick } from "@/sim/market";

// HIDDENLOT_MARKET_MINUTES=60 lets the simulated market take one step per 60
// minutes of real time. Steps run after a signed-in request has been answered,
// so nobody waits for them; a quiet hour is caught up on the next visit (up to
// a few steps). A lease keeps two server instances from stepping at once.
// Unset (the default, and locally), the market only moves on request.

const MAX_CATCH_UP = 3;
let lastCheck = 0; // per process: look at the database at most once a minute

export function marketMinutes(): number | null {
  const n = Number(process.env.HIDDENLOT_MARKET_MINUTES ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Runs the market steps that are due. Returns how many ran. */
export async function catchUpMarket(): Promise<number> {
  const minutes = marketMinutes();
  if (!minutes || Date.now() - lastCheck < 60_000) return 0;
  lastCheck = Date.now();
  const db = await getDb();
  const state = (await db.query<{ last_tick: Date | string | null }>(`SELECT last_tick FROM market_state WHERE id = 1`))[0];
  if (!state) return 0; // demo not loaded
  // A fresh demo starts with a few steps, so the market is not empty.
  const due = state.last_tick ? Math.floor((Date.now() - new Date(state.last_tick).getTime()) / (minutes * 60_000)) : MAX_CATCH_UP;
  if (due <= 0) return 0;
  const taken = await db.query(
    `INSERT INTO maintenance_leases (name, until) VALUES ('market', now() + interval '5 minutes')
     ON CONFLICT (name) DO UPDATE SET until = EXCLUDED.until WHERE maintenance_leases.until < now()
     RETURNING name`,
  );
  if (taken.length === 0) return 0;
  try {
    const steps = Math.min(due, MAX_CATCH_UP);
    for (let i = 0; i < steps; i++) await runMarketTick(db, await marketNow());
    return steps;
  } finally {
    await db.query(`UPDATE maintenance_leases SET until = now() WHERE name = 'market'`);
  }
}

/** One step now, for the local demo control and the script. */
export async function stepMarket() {
  return runMarketTick(await getDb(), await marketNow());
}

// The market follows the demo clock, so skipping ahead in a local demo keeps new stock fresh.
async function marketNow() {
  return new Date(Date.now() + (await getClockOffsetHours(await getDb())) * 3_600_000);
}
