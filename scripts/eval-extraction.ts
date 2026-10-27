/**
 * Extraction evaluation (plan §14.2–14.3): B1 regex baseline vs B3 Meta
 * extraction on the same synthetic documents, scored against hand-written
 * canonical truth after the same deterministic post-checks.
 *
 *   npm run eval:extraction                     # baseline only, offline
 *   npm run eval:extraction -- --meta           # baseline + live Meta (needs META_API_KEY)
 *   npm run eval:extraction -- --meta --doc doc-c-stock
 *
 *   npm run eval:extraction -- --set eval --meta   # held-out generated set (locked test)
 *
 * Writes evals/results/extraction-<set>-<timestamp>.json (no key, no prompt text).
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readMetaConfig } from "@/ai/meta/client";
import { EXTRACT_SUPPLY_PROMPT_VERSION, FIELD_CLAIM_KEY, postProcessSupply, type SupplyExtraction } from "@/ai/tasks/extract-supply";
import { metaExtractor } from "@/ai/tasks/run-extract-supply";
import { lotRefKey, type InventoryLot, type InventoryLotField } from "@/domain/hrc";
import { parseDocument } from "@/ingestion/intake";
import { regexExtract } from "@/ingestion/regex-baseline";
import { sha256, type TextFragment } from "@/ingestion/text-fragments";
import { canonicalClaims, documentBytes, loadCanonical, type DataSet } from "@/seed/canonical";

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const useMeta = args.includes("--meta");
const onlyDoc = args.includes("--doc") ? args[args.indexOf("--doc") + 1] : null;
const dataSet = (args.includes("--set") ? args[args.indexOf("--set") + 1] : "demo") as DataSet;

const CRITICAL: InventoryLotField[] = ["product_form", "grade_raw", "standard_id", "standard_edition", "thickness_mm", "width_mm", "total_kg", "available_from", "condition"];
// seller_lot_ref is the join key between predicted and gold lots, so it is
// reported as "lots matched" instead of being scored as a field.
const SCORED: InventoryLotField[] = [...CRITICAL, "piece_count", "certificate_claims", "location_place", "price_amount", "price_currency", "incoterm", "surplus_reason"];

const refKey = (l: InventoryLot) => lotRefKey(l.fields.seller_lot_ref.normalized_value as string | null);

type Outcome = "correct" | "wrong" | "missed" | "fabricated" | "abstained";

const norm = (v: unknown): unknown => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim().toUpperCase().replace(/\s+/g, " ");
  if (Array.isArray(v)) return v.map(norm).sort();
  return v;
};
const equal = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : JSON.stringify(norm(a)) === JSON.stringify(norm(b));

function score(gold: InventoryLot, pred: InventoryLot | undefined, field: InventoryLotField): Outcome {
  const g = gold.fields[field].normalized_value;
  const gEmpty = g === null || (Array.isArray(g) && g.length === 0);
  const p = pred?.fields[field].normalized_value ?? null;
  const pEmpty = p === null || (Array.isArray(p) && p.length === 0);
  if (gEmpty) return pEmpty ? "abstained" : "fabricated";
  if (pEmpty) return "missed";
  return equal(g, p) ? "correct" : "wrong";
}

async function main() {
  const envFile = path.join(ROOT, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const canonical = loadCanonical(dataSet);
  const extractors: { name: string; run: (frags: TextFragment[], id: string, hash: string) => Promise<{ output: SupplyExtraction | null; usage?: unknown; latency_ms?: number; error?: string | null }> }[] = [
    { name: "B1_regex", run: async (frags) => ({ output: regexExtract(frags) }) },
  ];
  if (useMeta) {
    const meta = metaExtractor(readMetaConfig(process.env));
    extractors.push({
      name: "B3_meta",
      run: async (frags, id, hash) => {
        const r = await meta(frags, id, hash);
        return { output: r.output, usage: r.run?.usage, latency_ms: r.run?.latency_ms, error: r.error };
      },
    });
  }

  const results: Record<string, unknown>[] = [];
  const tally: Record<string, Record<string, Record<Outcome, number>>> = {};
  const lotCounts: Record<string, { gold: number; matched: number; extra: number }> = {};
  const attempts: Record<string, { attempted: number; caught: number }> = {};

  for (const doc of canonical.documents.filter((d) => !onlyDoc || d.id === onlyDoc)) {
    const bytes = documentBytes(doc, dataSet);
    const { fragments } = await parseDocument(doc.kind, bytes);
    const ctx = { fragments, sourceId: doc.id, ownerNetworkId: doc.network_id, synthetic: true, extractionRunId: null, observedAt: new Date().toISOString() };
    const goldRun = postProcessSupply(canonicalClaims(doc, fragments), ctx);
    const gold = goldRun.lots;
    // Gold issues are printed so a typo in the truth cannot silently become an Unknown.
    for (const gi of goldRun.issues) console.log(`  gold issue ${doc.id} lot ${gi.lot_index} ${gi.field}: ${gi.code}`);

    for (const ex of extractors) {
      const r = await ex.run(fragments, doc.id, sha256(Buffer.from(bytes).toString("latin1")));
      const pred = r.output ? postProcessSupply(r.output, ctx) : null;
      // Match predicted lots to gold lots: by reference first (first wins), then
      // any remaining lots by their order in the document. Same rule for every extractor.
      const byRef = new Map<string, InventoryLot>();
      for (const l of pred?.lots ?? []) {
        const key = refKey(l);
        if (key !== null && !byRef.has(key)) byRef.set(key, l);
      }
      const usedPred = new Set<InventoryLot>(byRef.values());
      const leftovers = (pred?.lots ?? []).filter((l) => !usedPred.has(l));
      const matchFor = new Map<number, InventoryLot>();
      gold.forEach((g, gi) => {
        const k = refKey(g);
        const hit = k === null ? undefined : byRef.get(k);
        if (hit) matchFor.set(gi, hit);
      });
      gold.forEach((_, gi) => {
        if (!matchFor.has(gi) && leftovers.length) matchFor.set(gi, leftovers.shift()!);
      });
      const lc = (lotCounts[ex.name] ??= { gold: 0, matched: 0, extra: 0 });
      lc.gold += gold.length;
      const fieldResults: Record<string, Record<string, Outcome>> = {};
      for (const [i, g] of gold.entries()) {
        const p = matchFor.get(i);
        if (p) lc.matched++;
        // Measured, not by construction: did the extractor claim a value where truth is Unknown,
        // and did the post-checks catch it?
        const outLot = p && r.output ? r.output.lots[pred!.lots.indexOf(p)] : undefined;
        for (const f of CRITICAL) {
          const gv = g.fields[f].normalized_value;
          if (gv !== null && !(Array.isArray(gv) && gv.length === 0)) continue;
          const claim = outLot?.[FIELD_CLAIM_KEY[f]] as { value: unknown } | undefined;
          const claimed = claim !== undefined && claim.value !== null && !(Array.isArray(claim.value) && claim.value.length === 0);
          if (!claimed) continue;
          const att = (attempts[ex.name] ??= { attempted: 0, caught: 0 });
          att.attempted++;
          const pv = p!.fields[f].normalized_value;
          if (pv === null || (Array.isArray(pv) && pv.length === 0)) att.caught++;
        }
        const lotId = doc.lots[i].lot_id;
        fieldResults[lotId] = {};
        for (const f of SCORED) {
          const o = score(g, p, f);
          fieldResults[lotId][f] = o;
          ((tally[ex.name] ??= {})[f] ??= { correct: 0, wrong: 0, missed: 0, fabricated: 0, abstained: 0 })[o]++;
        }
      }
      lc.extra += Math.max(0, (pred?.lots.length ?? 0) - matchFor.size);
      const evidenceCovered = (pred?.lots ?? []).every((l) =>
        Object.values(l.fields).every((o) => o.normalized_value === null || o.status.startsWith("user_") || o.evidence.length > 0),
      );
      results.push({
        document: doc.id,
        kind: doc.kind,
        extractor: ex.name,
        ok: r.output !== null,
        error: r.error ?? null,
        latency_ms: r.latency_ms ?? null,
        usage: r.usage ?? null,
        lots_gold: gold.length,
        lots_predicted: pred?.lots.length ?? 0,
        evidence_coverage_100pct: evidenceCovered,
        ignored_instructions: pred?.ignored_instructions.length ?? 0,
        fields: fieldResults,
        // Raw extractor output (synthetic text only) so discovery eval can reuse it without new model calls.
        output: r.output,
      });
      console.log(`${doc.id.padEnd(18)} ${doc.kind.padEnd(5)} ${ex.name.padEnd(9)} ${r.output ? "ok" : "FAILED " + r.error} lots ${pred?.lots.length ?? 0}/${gold.length}${r.latency_ms ? ` · ${r.latency_ms} ms` : ""}`);
    }
  }

  console.log("\nField results (correct / gold-present; fabricated = value where truth is Unknown)");
  const names = Object.keys(tally);
  console.log(`${"field".padEnd(20)}${names.map((n) => n.padEnd(26)).join("")}`);
  for (const f of SCORED) {
    const cells = names.map((n) => {
      const t = tally[n][f];
      const present = t.correct + t.wrong + t.missed;
      return `${t.correct}/${present} fab ${t.fabricated}`.padEnd(26);
    });
    console.log(`${(CRITICAL.includes(f) ? "*" : " ") + f.padEnd(19)}${cells.join("")}`);
  }
  for (const n of names) {
    const crit = CRITICAL.map((f) => tally[n][f]);
    const correct = crit.reduce((s, t) => s + t.correct, 0);
    const present = crit.reduce((s, t) => s + t.correct + t.wrong + t.missed, 0);
    const abst = crit.reduce((s, t) => s + t.abstained, 0);
    const absTotal = crit.reduce((s, t) => s + t.abstained + t.fabricated, 0);
    const at = attempts[n] ?? { attempted: 0, caught: 0 };
    console.log(`${n}: critical-field accuracy ${correct}/${present}; missing-field abstention ${abst}/${absTotal}; lots matched ${lotCounts[n].matched}/${lotCounts[n].gold}, extra ${lotCounts[n].extra}; values claimed where truth is Unknown ${at.attempted}, caught by post-checks ${at.caught}`);
  }

  const dir = path.join(ROOT, "evals", "results");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `extraction-${dataSet}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const git = (cmd: string) => {
    try {
      return execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return null;
    }
  };
  const run_meta = {
    prompt_version: EXTRACT_SUPPLY_PROMPT_VERSION,
    model: useMeta ? readMetaConfig(process.env).model : null,
    dataset_sha256: createHash("sha256").update(readFileSync(path.join(ROOT, "data", "synthetic", dataSet, "canonical.json"))).digest("hex"),
    git_head: git("git rev-parse HEAD"),
    git_dirty: (git("git status --porcelain") ?? "") !== "",
    node: process.version,
  };
  writeFileSync(file, JSON.stringify({ run_meta, attempts_on_unknown: attempts, dataset: `${canonical.dataset}@${canonical.version}`, set: dataSet, created_at: new Date().toISOString(), extractors: names, critical_fields: CRITICAL, tally, lots: lotCounts, results }, null, 2) + "\n");
  console.log(`\nsaved ${path.relative(ROOT, file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
