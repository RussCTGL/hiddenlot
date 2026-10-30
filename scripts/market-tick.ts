/**
 * Runs N steps of the simulated market against the configured database (the
 * hosted one when DATABASE_URL is set, else the local embedded one; stop
 * `npm run dev` first for the embedded one) and prints what happened.
 *
 *   npm run market:tick -- 5
 */
import { openConfiguredDb } from "@/db/client";
import { runMarketTick } from "@/sim/market";

async function main() {
  const steps = Math.max(1, Math.min(48, Number(process.argv[2] ?? 1) || 1));
  const db = await openConfiguredDb();
  for (let i = 0; i < steps; i++) {
    const r = await runMarketTick(db, new Date());
    for (const e of r.events) console.log(`tick ${r.tick} · ${e.network_id} · ${e.kind} · ${e.summary}`);
    if (r.events.length === 0) console.log(`tick ${r.tick} · quiet`);
  }
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
