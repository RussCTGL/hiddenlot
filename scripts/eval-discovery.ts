/**
 * Discovery evaluation (plan §14.1–14.3). Uses the extractor outputs saved by
 * eval-extraction, so it makes no model calls of its own.
 *
 *   npm run eval:discovery -- --set eval          # latest extraction results for the set
 *   npm run eval:discovery -- --results evals/results/extraction-eval-….json
 *
 * Systems, all on the same documents, demands and visibility (every network
 * shares all fields with every other):
 *   B2  hand-written structured truth + hard constraints  (reference labels)
 *   B1  regex extraction + the same constraints
 *   B3  Meta extraction + the same constraints              (HiddenLot)
 *   A1  Meta extraction, NO hard constraints, top-5 by score (offline ablation only)
 * Owner review is simulated identically for every system: extracted values are
 * confirmed as-is, Unknowns stay Unknown.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { postProcessSupply, type SupplyExtraction } from "@/ai/tasks/extract-supply";
import { evaluateConstraints, REVIEWABLE, type CompatibilityStatus } from "@/discovery/constraints";
import { scoreCandidate } from "@/discovery/score";
import { Demand, HRC_SCHEMA_VERSION, lotRefKey, type InventoryLot } from "@/domain/hrc";
import { parseDocument } from "@/ingestion/intake";
import { canonicalClaims, documentBytes, loadCanonical, type DataSet } from "@/seed/canonical";

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const arg = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const set = (arg("--set") ?? "eval") as DataSet;
const NOW = new Date(arg("--now") ?? "2026-11-01T00:00:00.000Z");

function latestResults(): string {
  const dir = path.join(ROOT, "evals", "results");
  const files = readdirSync(dir).filter((f) => f.startsWith(`extraction-${set}-`) && f.endsWith(".json")).sort();
  for (const f of files.reverse()) {
    const j = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    if (j.results?.some((r: { output?: unknown }) => r.output !== undefined)) return path.join(dir, f);
  }
  throw new Error(`no extraction results with saved outputs for set ${set}; run eval:extraction first`);
}

const reviewOwner = (l: InventoryLot, lotId: string): InventoryLot => ({
  ...l,
  lot_id: lotId,
  status: "published",
  last_verified_at: NOW.toISOString(),
  fields: Object.fromEntries(
    Object.entries(l.fields).map(([k, o]) => [k, o.normalized_value === null ? o : { ...o, status: "user_confirmed", review: { status: "confirmed", reviewer_id: "sim" } }]),
  ) as InventoryLot["fields"],
});

async function main() {
  const resultsFile = arg("--results") ? path.resolve(arg("--results")!) : latestResults();
  const saved = JSON.parse(readFileSync(resultsFile, "utf8")) as { results: { document: string; extractor: string; output: SupplyExtraction | null }[] };
  const canonical = loadCanonical(set);
  const demands = canonical.demands.map((d) =>
    Demand.parse({ ...Object.fromEntries(Object.entries(d).filter(([k]) => k !== "created_by")), schema_version: HRC_SCHEMA_VERSION, version: 1, synthetic: true }),
  );

  // Lots per system, keyed by gold lot id (predicted lots matched by reference).
  const systems = ["B2_truth", ...new Set(saved.results.map((r) => r.extractor))];
  const lots: Record<string, { lot: InventoryLot; network: string }[]> = Object.fromEntries(systems.map((s) => [s, []]));
  for (const doc of canonical.documents) {
    const { fragments } = await parseDocument(doc.kind, documentBytes(doc, set));
    const ctx = { fragments, sourceId: doc.id, ownerNetworkId: doc.network_id, synthetic: true, extractionRunId: null, observedAt: NOW.toISOString() };
    const gold = postProcessSupply(canonicalClaims(doc, fragments), ctx).lots;
    gold.forEach((g, i) => lots.B2_truth.push({ lot: reviewOwner(g, doc.lots[i].lot_id), network: doc.network_id }));
    for (const r of saved.results.filter((x) => x.document === doc.id)) {
      const pred = r.output ? postProcessSupply(r.output, ctx).lots : [];
      // Same matching as eval-extraction: by reference, then remaining lots by document order.
      const taken = new Set<number>();
      const idxOf = pred.map((p) => {
        const k = lotRefKey(p.fields.seller_lot_ref.normalized_value as string | null);
        const idx = gold.findIndex((g, gi) => !taken.has(gi) && k !== null && lotRefKey(g.fields.seller_lot_ref.normalized_value as string | null) === k);
        if (idx >= 0) taken.add(idx);
        return idx;
      });
      idxOf.forEach((idx, i) => {
        if (idx >= 0) return;
        const free = gold.findIndex((_, gi) => !taken.has(gi));
        if (free >= 0) {
          taken.add(free);
          idxOf[i] = free;
        }
      });
      pred.forEach((p, i) => {
        const idx = idxOf[i];
        lots[r.extractor].push({ lot: reviewOwner(p, idx >= 0 ? doc.lots[idx].lot_id : `${doc.id}:extra-${i}`), network: doc.network_id });
      });
    }
  }

  type Pair = { demand: string; lot: string; status: CompatibilityStatus; lower: number | null; own: boolean };
  const assess = (system: string): Pair[] =>
    demands.flatMap((d) =>
      lots[system].map(({ lot, network }) => {
        const own = network === d.buyer_network_id;
        const a = evaluateConstraints(lot, d, { own, grant_id: own ? null : "eval-grant", withheld: [] }, NOW);
        return { demand: d.demand_id, lot: lot.lot_id, status: a.compatibility_status, lower: scoreCandidate(lot, d, NOW).lower, own };
      }),
    );
  const goldPairs = assess("B2_truth");
  const goldLabel = new Map(goldPairs.map((p) => [`${p.demand}/${p.lot}`, p.status]));
  const isRev = (s: CompatibilityStatus | undefined) => s !== undefined && REVIEWABLE.includes(s);
  const goldReviewable = goldPairs.filter((p) => isRev(p.status));

  const summary: Record<string, unknown> = {};
  console.log(`set ${set} · ${demands.length} demands × ${lots.B2_truth.length} lots · gold reviewable pairs ${goldReviewable.length} · now ${NOW.toISOString()}`);
  console.log(`results from ${path.relative(ROOT, resultsFile)}\n`);
  for (const sys of systems) {
    const pairs = assess(sys);
    const rev = pairs.filter((p) => isRev(p.status));
    const tp = rev.filter((p) => isRev(goldLabel.get(`${p.demand}/${p.lot}`)));
    const violations = rev.filter((p) => goldLabel.get(`${p.demand}/${p.lot}`) === "incompatible");
    const other = rev.filter((p) => !isRev(goldLabel.get(`${p.demand}/${p.lot}`)) && goldLabel.get(`${p.demand}/${p.lot}`) !== "incompatible");
    // Precision@5: per demand, top min(5, n) reviewable by lower bound; macro average.
    const p5: number[] = [];
    for (const d of demands) {
      const top = rev.filter((p) => p.demand === d.demand_id).sort((a, b) => (b.lower ?? -1) - (a.lower ?? -1)).slice(0, 5);
      if (top.length) p5.push(top.filter((p) => isRev(goldLabel.get(`${p.demand}/${p.lot}`))).length / top.length);
    }
    const s = {
      reviewable: rev.length,
      true_positive: tp.length,
      candidate_recall: `${tp.length}/${goldReviewable.length}`,
      hard_constraint_violations: violations.length,
      reviewable_but_gold_needs_evidence_or_review: other.length,
      precision_at_5_macro: p5.length ? Math.round((p5.reduce((a, b) => a + b, 0) / p5.length) * 1000) / 1000 : null,
      demands_with_results: p5.length,
    };
    summary[sys] = s;
    console.log(`${sys.padEnd(10)} reviewable ${String(s.reviewable).padStart(3)} · recall ${s.candidate_recall.padStart(6)} · violations ${s.hard_constraint_violations} · other ${s.reviewable_but_gold_needs_evidence_or_review} · P@5 ${s.precision_at_5_macro}`);
  }

  // A1 ablation: Meta extraction, no hard constraints — top 5 by score per demand.
  if (systems.includes("B3_meta")) {
    let shown = 0;
    let bad = 0;
    for (const d of demands) {
      const ranked = lots.B3_meta
        .map(({ lot }) => ({ lot: lot.lot_id, lower: scoreCandidate(lot, d, NOW).lower ?? -1 }))
        .sort((a, b) => b.lower - a.lower)
        .slice(0, 5);
      shown += ranked.length;
      bad += ranked.filter((r) => goldLabel.get(`${d.demand_id}/${r.lot}`) === "incompatible").length;
    }
    summary.A1_no_constraints = { shown, known_violations_shown: bad };
    console.log(`A1 (no hard constraints, top 5 by score): ${bad}/${shown} recommendations violate a known hard constraint`);
  }

  // Network lift on gold labels: reviewable candidates from the buyer's own network vs all authorized networks.
  const local = goldReviewable.filter((p) => p.own).length;
  summary.network_lift = { local_reviewable: local, cross_network_reviewable: goldReviewable.length - local, demands_with_no_local_but_cross: demands.filter((d) => !goldReviewable.some((p) => p.demand === d.demand_id && p.own) && goldReviewable.some((p) => p.demand === d.demand_id && !p.own)).length };
  console.log(`Network lift (gold): local ${local} vs cross-network ${goldReviewable.length - local} reviewable pairs`);

  const out = path.join(ROOT, "evals", "results", `discovery-${set}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ set, now: NOW.toISOString(), source: path.relative(ROOT, resultsFile), summary }, null, 2) + "\n");
  console.log(`\nsaved ${path.relative(ROOT, out)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
