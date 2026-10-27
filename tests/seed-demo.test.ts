import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getOpportunityForActor, listOpportunitiesForActor, type Actor } from "@/auth/access";
import { openDb, type Db } from "@/db/client";
import { seedDemo } from "@/seed/demo";
import { loadCanonical } from "@/seed/canonical";
import { decideOpportunity, revokeGrant, setLotStatus } from "@/workflow/actions";

// P3 acceptance: the seeded demo reproduces every canonical label through the
// real pipeline, and the demo story (plan §6.4 Definition of Done) holds.

let db: Db;
const NOW = new Date("2026-10-27T12:00:00.000Z");
const ANA: Actor = { id: "u-ana", network_id: "net-a", role: "trader" };
const BO: Actor = { id: "u-bo", network_id: "net-b", role: "trader" };

before(async () => {
  db = await openDb(null);
});
after(async () => db.close());

test("seed loads through intake, review and publish", async () => {
  const r = await seedDemo(db, NOW);
  assert.equal(r.lots, 11);
  assert.equal(r.demands, 2);
  assert.ok(r.opportunities > 0);
});

test("every demand × lot pair gets exactly the canonical label", async () => {
  const c = loadCanonical();
  const rows = await db.query<{ demand_id: string; lot_id: string; compatibility_status: string }>(
    `SELECT a.demand_id, a.lot_id, a.compatibility_status FROM match_assessments a
      JOIN lots l ON l.id = a.lot_id AND l.current_version = a.lot_version
      JOIN demands d ON d.id = a.demand_id AND d.current_version = a.demand_version`,
  );
  const got = new Map(rows.map((r) => [`${r.demand_id}/${r.lot_id}`, r.compatibility_status]));
  const mismatches: string[] = [];
  for (const [demand, lots] of Object.entries(c.expected)) {
    for (const [lot, label] of Object.entries(lots)) {
      const actual = got.get(`${demand}/${lot}`);
      if (actual !== label) mismatches.push(`${demand}/${lot}: expected ${label}, got ${actual ?? "not assessed"}`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test("cross-network lift: Network A's own stock has no reviewable match for dem-a-01; B-018 is found across networks", async () => {
  const opps = (await listOpportunitiesForActor(db, ANA, NOW)).filter((o) => o.status !== "invalidated" && o.demand_id === "dem-a-01");
  const reviewable = opps.filter((o) => ["evidence_supported", "declared_match", "conditional_candidate"].includes(o.compatibility_status));
  assert.deepEqual(reviewable.map((o) => [o.lot_id, o.novelty]), [["lot-b-018", "cross_network"]]);
});

test("demo story: shortlist, then the seller sells the lot and the opportunity is invalidated", async () => {
  const opp = (await listOpportunitiesForActor(db, ANA, NOW)).find((o) => o.lot_id === "lot-b-018" && o.status !== "invalidated")!;
  await decideOpportunity(db, ANA, opp.id, "shortlisted", "Spec, quantity and price fit; request MTC copy", NOW);
  const lot = await db.query<{ current_version: number }>(`SELECT current_version FROM lots WHERE id = 'lot-b-018'`);
  await setLotStatus(db, BO, "lot-b-018", lot[0].current_version, "sold", NOW);
  const view = await getOpportunityForActor(db, ANA, opp.id, NOW);
  assert.equal(view.opportunity.status, "invalidated");
  assert.equal(view.lot, null);
});

test("demo story: revoking Network C's grant hides its candidates", async () => {
  await revokeGrant(db, { id: "u-chen", network_id: "net-c", role: "trader" }, "grant-c-to-a", NOW);
  const live = (await listOpportunitiesForActor(db, ANA, NOW)).filter((o) => o.seller_network_id === "net-c" && o.status !== "invalidated");
  assert.equal(live.length, 0);
});

test("canonical truth post-processes with only the intended issues (B-021 unit-less sizes and 'ton')", async () => {
  const { canonicalClaims, documentBytes } = await import("@/seed/canonical");
  const { parseDocument } = await import("@/ingestion/intake");
  const { postProcessSupply } = await import("@/ai/tasks/extract-supply");
  const codes: string[] = [];
  for (const doc of loadCanonical().documents) {
    const { fragments } = await parseDocument(doc.kind, documentBytes(doc));
    const r = postProcessSupply(canonicalClaims(doc, fragments), { fragments, sourceId: doc.id, ownerNetworkId: doc.network_id, synthetic: true, extractionRunId: null, observedAt: NOW.toISOString() });
    codes.push(...r.issues.map((i) => `${doc.lots[i.lot_index!].lot_id}.${i.field}:${i.code}`));
  }
  assert.deepEqual(codes.sort(), ["lot-b-021.thickness_mm:unit_missing", "lot-b-021.total_kg:ambiguous_ton", "lot-b-021.width_mm:unit_missing"]);
});

test("the planted instruction is reported as ignored and sits in an incompatible lot's section", async () => {
  const runs = await db.query<{ ignored_instructions: { note: string; evidence: string[] }[] }>(`SELECT ignored_instructions FROM extraction_runs WHERE document_id = (SELECT source_document_id FROM lots WHERE id = 'lot-b-030')`);
  assert.equal(runs[0].ignored_instructions.length, 1);
  const audit = await db.query<{ n: string }>(`SELECT count(*) AS n FROM lot_versions WHERE change_note LIKE 'seed: scripted%'`);
  assert.equal(Number(audit[0].n), 11);
});
