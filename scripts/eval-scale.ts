/**
 * Volume test: a large synthetic multi-network world, well beyond the MVP size
 * the design assumed (plan §12.1: ~60 lots × 15 demands), checked
 * against an independent oracle before and after a round of changes, with
 * timings for the operations a user triggers. No model calls.
 *
 *   npm run eval:scale -- --size m            # presets: test, s, m, l
 *   npm run eval:scale -- --size m --no-save  # don't write a result file
 *
 * Phases:
 *   1. generate + load (lots, demands, grants incl. revoked/expired/no-discovery)
 *   2. full discovery, then a second run that must change nothing
 *   3. oracle check: authorization, completeness, hard constraints, withheld fields, leaks
 *   4. page operations per network (list, rejected, detail), timed
 *   5. changes through the real actions: lots sold, grants revoked, demands edited,
 *      one new network-wide grant; clock +30 h so some stock goes stale
 *   6. oracle check again on the changed world
 */
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOpportunityForActor, listOpportunitiesForActor, listRejectedForActor, type Actor } from "@/auth/access";
import { openDb } from "@/db/client";
import { discoverAll } from "@/discovery/engine";
import { checkScale, failureCount, type ScaleReport } from "@/seed/scale-check";
import { ALL_FIELDS, generateScale, loadScale, SCALE_PRESETS, worldHash, type ScaleConfig } from "@/seed/scale";
import { createGrant, revokeGrant, setLotStatus, updateDemand, type DemandInput } from "@/workflow/actions";

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const arg = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const size = (arg("--size") ?? "s") as keyof typeof SCALE_PRESETS;
const config: ScaleConfig = SCALE_PRESETS[size];
if (!config) throw new Error(`unknown size ${size}; use ${Object.keys(SCALE_PRESETS).join(", ")}`);

const timings: Record<string, number | Record<string, number>> = {};
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  timings[label] = Math.round(performance.now() - t0);
  console.log(`  ${label.padEnd(44)} ${String(timings[label]).padStart(7)} ms`);
  return out;
}
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: Math.round(s[s.length - 1] ?? 0) };
};
async function sampleTimes(label: string, items: (() => Promise<unknown>)[]) {
  const xs: number[] = [];
  for (const fn of items) {
    const t0 = performance.now();
    await fn();
    xs.push(performance.now() - t0);
  }
  timings[label] = stats(xs);
  const s = timings[label] as ReturnType<typeof stats>;
  console.log(`  ${label.padEnd(44)} p50 ${s.p50} ms · p95 ${s.p95} ms · max ${s.max} ms (n=${s.n})`);
}

function printReport(name: string, r: ScaleReport) {
  console.log(`\n${name}: ${r.expected_pairs} visible pairs · ${r.open_opportunities} open opportunities (${r.reviewable_open} reviewable) · ${r.views_checked} detail views checked`);
  console.log(`  statuses ${Object.entries(r.by_status).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  for (const [k, v] of Object.entries(r.failures)) {
    console.log(`  ${v === 0 ? "ok  " : "FAIL"} ${k.padEnd(32)} ${v}`);
    for (const ex of r.examples[k as keyof ScaleReport["failures"]] ?? []) console.log(`         ${ex}`);
  }
}

async function main() {
  const world = generateScale(config);
  const again = generateScale(config);
  const hash = worldHash(world);
  if (worldHash(again) !== hash) throw new Error("generator is not deterministic");
  const now = new Date(world.now);
  const deadAtLoad = new Set(world.grants.filter((g) => g.revoked || !g.allow_discovery || (g.expires_at !== null && new Date(g.expires_at) <= now)).map((g) => g.id));
  console.log(
    `size ${size} · seed ${config.seed} · world ${hash} · ${world.networks.length} networks · ${world.lots.length} lots · ${world.demands.length} demands · ${world.grants.length} grants (${deadAtLoad.size} revoked, expired or no-discovery)\n`,
  );

  const db = await openDb(null);
  await timed("load (bulk insert)", () => loadScale(db, world));
  const first = await timed("discoverAll, cold", () => discoverAll(db, now));
  const second = await timed("discoverAll, warm (nothing changed)", () => discoverAll(db, now));
  console.log(`  first run: ${JSON.stringify(first)}`);
  console.log(`  second run: ${JSON.stringify(second)}`);
  const idempotent = second.new_opportunities === 0 && second.invalidated === 0;

  const before = await checkScale(db, world, now, { deadAtLoad, viewsPerNetwork: 3 });
  printReport("Check 1 (after load)", before);

  // Page operations. Every read refreshes the actor's network first (time-based rules have no event).
  console.log("\nPage operations");
  const actors: Actor[] = world.networks.map((n) => ({ id: `u-${n.id.slice(4)}`, network_id: n.id, role: "trader" }));
  await sampleTimes("opportunity list (incl. refresh)", actors.map((a) => () => listOpportunitiesForActor(db, a, now)));
  await sampleTimes("rejected list", actors.map((a) => () => listRejectedForActor(db, a, now)));
  const detailTargets: (() => Promise<unknown>)[] = [];
  for (const a of actors) {
    const open = (await db.query<{ id: string }>(`SELECT id FROM opportunities WHERE buyer_network_id = $1 AND status <> 'invalidated' ORDER BY id LIMIT 2`, [a.network_id])).map((r) => r.id);
    for (const id of open) detailTargets.push(() => getOpportunityForActor(db, a, id, now));
  }
  await sampleTimes("opportunity detail (incl. refresh)", detailTargets);
  const sizes = await db.query<{ network: string; open: string; json_kb: string }>(
    `SELECT o.buyer_network_id AS network, count(*) AS open, round(sum(length(a.checks::text) + length(a.score::text)) / 1024.0) AS json_kb
       FROM opportunities o JOIN match_assessments a ON a.id = o.assessment_id WHERE o.status <> 'invalidated' GROUP BY 1 ORDER BY 2 DESC`,
  );
  console.log(`  open opportunities per network: ${sizes.map((s) => `${s.network} ${s.open} (${s.json_kb} KB)`).join(" · ")}`);

  // Changes through the real actions.
  console.log("\nChanges (real actions)");
  const later = new Date(now.getTime() + 30 * 3_600_000);
  const published = await db.query<{ id: string; owner_network_id: string; current_version: number }>(
    `SELECT id, owner_network_id, current_version FROM lots WHERE status = 'published' ORDER BY id`,
  );
  const toSell = published.filter((_, i) => i % 30 === 0);
  const actorOf = (networkId: string): Actor => ({ id: `u-${networkId.slice(4)}`, network_id: networkId, role: "trader" });
  await sampleTimes(`mark lot sold (${toSell.length})`, toSell.map((l) => () => setLotStatus(db, actorOf(l.owner_network_id), l.id, l.current_version, "sold", later)));

  const live = await db.query<{ id: string; owner_network_id: string }>(`SELECT id, owner_network_id FROM sharing_grants WHERE revoked_at IS NULL ORDER BY id`);
  const toRevoke = live.filter((_, i) => i % 4 === 0);
  await sampleTimes(`revoke grant (${toRevoke.length})`, toRevoke.map((g) => () => revokeGrant(db, actorOf(g.owner_network_id), g.id, later)));

  const demands = await db.query<{ id: string; buyer_network_id: string; current_version: number; data: DemandInput }>(
    `SELECT d.id, d.buyer_network_id, d.current_version, v.data FROM demands d JOIN demand_versions v ON v.demand_id = d.id AND v.version = d.current_version WHERE d.status = 'active' ORDER BY d.id`,
  );
  const toEdit = demands.filter((_, i) => i % 10 === 0);
  await sampleTimes(
    `edit demand quantity (${toEdit.length})`,
    toEdit.map((d) => () => {
      const { quantity_kg, ...rest } = d.data;
      const input = Object.fromEntries(Object.entries(rest).filter(([k]) => !["schema_version", "demand_id", "version", "buyer_network_id", "synthetic"].includes(k)));
      return updateDemand(db, actorOf(d.buyer_network_id), d.id, d.current_version, { ...input, quantity_kg: { ...quantity_kg, max: quantity_kg.max + 5000 } } as DemandInput, later);
    }),
  );

  // One owner shares all its lots with a network it had no grant to (the Sharing page action).
  const pairs = await db.query<{ owner: string; recipient: string }>(
    `SELECT o.id AS owner, r.id AS recipient FROM networks o CROSS JOIN networks r
      WHERE o.id <> r.id AND NOT EXISTS (SELECT 1 FROM sharing_grants g WHERE g.owner_network_id = o.id AND g.recipient_network_id = r.id AND g.lot_id IS NULL)
      ORDER BY 1, 2 LIMIT 1`,
  );
  if (pairs[0]) {
    await timed(`new network-wide grant ${pairs[0].owner} → ${pairs[0].recipient}`, () =>
      createGrant(db, actorOf(pairs[0].owner), { recipient_network_id: pairs[0].recipient, lot_id: null, field_scope: ALL_FIELDS, allow_identity_disclosure: false, expires_at: null }, later),
    );
  }
  const rerun = await timed("discoverAll after changes (+30 h)", () => discoverAll(db, later));
  console.log(`  run: ${JSON.stringify(rerun)}`);

  const after = await checkScale(db, world, later, { deadAtLoad, viewsPerNetwork: 3 });
  printReport("Check 2 (after changes, +30 h)", after);

  const counts = Object.fromEntries(
    await Promise.all(
      ["lots", "lot_versions", "demands", "sharing_grants", "match_assessments", "opportunities", "audit_events"].map(async (t) => [t, Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`))[0].n)]),
    ),
  );
  console.log(`\nrows: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  console.log(`heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB · rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
  await db.close();

  const total = failureCount(before) + failureCount(after) + (idempotent ? 0 : 1);
  console.log(`\n${total === 0 ? "PASS" : "FAIL"}: ${total} failure(s); second discovery run ${idempotent ? "changed nothing" : "CHANGED DATA"}`);

  if (!args.includes("--no-save")) {
    const out = path.join(ROOT, "evals", "results", `scale-${size}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(
      out,
      JSON.stringify(
        {
          size,
          config,
          world_hash: hash,
          now: world.now,
          machine: { platform: process.platform, arch: process.arch, cpus: os.cpus()[0]?.model, node: process.version },
          world: { networks: world.networks.length, lots: world.lots.length, demands: world.demands.length, grants: world.grants.length, dead_grants_at_load: deadAtLoad.size },
          discovery: { first, second, idempotent, after_changes: rerun },
          check_after_load: before,
          check_after_changes: after,
          timings_ms: timings,
          rows: counts,
          pass: total === 0,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`saved ${path.relative(ROOT, out)}`);
  }
  if (total > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
