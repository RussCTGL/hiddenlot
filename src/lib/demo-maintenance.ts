import "server-only";
import { listNetworks } from "@/db/repo";
import { getDb } from "@/db/server";
import { seedDemo } from "@/seed/demo";

// HIDDENLOT_SEED_ON_START=true  loads the synthetic demo when the database is empty.
// HIDDENLOT_RESEED_HOURS=24     reloads it every N hours (clears everything visitors did).

export async function startDemoMaintenance() {
  const db = await getDb();
  if (process.env.HIDDENLOT_SEED_ON_START === "true" && (await listNetworks(db)).length === 0) {
    const r = await seedDemo(db, new Date());
    console.log(`[hiddenlot] seeded ${r.dataset}: ${r.lots} lots, ${r.demands} demands, ${r.opportunities} opportunities`);
  }
  const hours = Number(process.env.HIDDENLOT_RESEED_HOURS ?? 0);
  if (hours > 0) {
    const timer = setInterval(
      () => {
        seedDemo(db, new Date())
          .then((r) => console.log(`[hiddenlot] reseeded ${r.dataset}`))
          .catch((err) => console.error("[hiddenlot] reseed failed", err));
      },
      hours * 3_600_000,
    );
    timer.unref();
  }
}
