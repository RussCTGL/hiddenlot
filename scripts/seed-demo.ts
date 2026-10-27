/**
 * Resets the local database and loads the synthetic three-network demo.
 * Stop `npm run dev` first: the embedded database allows one process at a time.
 *
 *   npm run db:seed
 */
import { DEFAULT_DATA_DIR, openDb } from "@/db/client";
import { seedDemo } from "@/seed/demo";

async function main() {
  const db = await openDb(process.env.HIDDENLOT_DB_DIR || DEFAULT_DATA_DIR);
  const report = await seedDemo(db, new Date());
  await db.close();
  console.log(`seeded ${report.dataset}: ${report.lots} lots, ${report.demands} demands, ${report.grants} grants, ${report.opportunities} open opportunities`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
