/**
 * Resets the database and loads the synthetic five-network demo: the hosted
 * one when DATABASE_URL is set, else the local embedded one. For the embedded
 * database, stop `npm run dev` first: it allows one process at a time.
 *
 *   npm run db:seed
 */
import { openConfiguredDb } from "@/db/client";
import { seedDemo } from "@/seed/demo";

async function main() {
  const db = await openConfiguredDb();
  const report = await seedDemo(db, new Date());
  await db.close();
  console.log(`seeded ${report.dataset}: ${report.lots} lots, ${report.demands} demands, ${report.grants} grants, ${report.opportunities} open opportunities`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
