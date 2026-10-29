import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { getDocumentContentForActor, getDocumentForActor, getOpportunityForActor, listOpportunitiesForActor, NotFoundError, type Actor } from "@/auth/access";
import type { Db } from "@/db/client";
import { freshDb } from "./db";
import { insertDemand, insertLot } from "@/db/repo";
import { discoverAll } from "@/discovery/engine";
import { createGrant, decideOpportunity, reviewLot, revokeGrant, setLotStatus } from "@/workflow/actions";
import { ALL_LOT_FIELDS } from "@/workflow/actions";
import { demand, lot, NOW } from "./helpers";

// Discovery, authorization and invalidation against a real (in-memory)
// Postgres. Plan §6.4 Definition of Done and §15.2 permission tests.

let db: Db;
const A: Actor = { id: "u-a", network_id: "net-a", role: "trader" };
const B: Actor = { id: "u-b", network_id: "net-b", role: "trader" };
const C: Actor = { id: "u-c", network_id: "net-c", role: "trader" };

before(async () => {
  db = await freshDb();
});
after(async () => db.close());

beforeEach(async () => {
  for (const t of ["audit_events", "review_decisions", "opportunities", "match_assessments", "sharing_grants", "demand_versions", "demands", "lot_versions", "lots", "source_fragments", "source_documents", "users", "networks"]) {
    await db.query(`DELETE FROM ${t}`);
  }
  for (const [id, alias] of [["net-a", "Network A"], ["net-b", "Network B"], ["net-c", "Network C"]]) {
    await db.query(`INSERT INTO networks (id, name, alias) VALUES ($1, $2, $3)`, [id, `${alias} private name`, alias]);
  }
  for (const u of [A, B, C]) await db.query(`INSERT INTO users (id, network_id, name, role) VALUES ($1,$2,$3,'trader')`, [u.id, u.network_id, u.id]);
  await insertDemand(db, demand(), A.id);
  await insertLot(db, lot(), null, B.id); // B-018: matches the demand
  await insertLot(db, lot({ seller_lot_ref: "B-021", grade_raw: "Q235B", standard_id: "GB/T 700" }, { lot_id: "lot-b-021" }), null, B.id);
  await insertLot(db, lot({ seller_lot_ref: "A-007", width_mm: 1219 }, { lot_id: "lot-a-007", owner_network_id: "net-a" }), null, A.id);
});

const oppsOf = async (actor: Actor) => (await listOpportunitiesForActor(db, actor, NOW)).filter((o) => o.status !== "invalidated");

test("without a grant, another network's lot is never assessed", async () => {
  const stats = await discoverAll(db, NOW);
  assert.equal(stats.pairs, 1); // only A's own lot against A's demand
  const rows = await db.query(`SELECT 1 FROM match_assessments WHERE lot_id LIKE 'lot-b-%'`);
  assert.equal(rows.length, 0);
  assert.equal((await oppsOf(A)).length, 0); // A-007 is too narrow → incompatible, no opportunity
});

test("a grant makes B's lot discoverable for A as a cross-network opportunity", async () => {
  const { stats } = await createGrant(db, B, { recipient_network_id: "net-a", lot_id: null, field_scope: ALL_LOT_FIELDS, allow_identity_disclosure: false, expires_at: null }, NOW);
  assert.ok(stats.some((s) => s.new_opportunities > 0));
  const opps = await oppsOf(A);
  assert.equal(opps.length, 2); // B-018 declared match; B-021 needs engineering review (Q235B vs SS400)
  const main = opps.find((o) => o.lot_id === "lot-b-018")!;
  assert.equal(main.novelty, "cross_network");
  assert.equal(main.compatibility_status, "declared_match");
  assert.equal(opps.find((o) => o.lot_id === "lot-b-021")!.compatibility_status, "engineering_review_required");

  const view = await getOpportunityForActor(db, A, main.id, NOW);
  assert.match(view.seller_label, /identity withheld/);
  assert.ok(!JSON.stringify(view).includes("private name"));
});

test("incompatible pairs keep a rejected trace but never become opportunities", async () => {
  await discoverAll(db, NOW);
  const trace = await db.query<{ compatibility_status: string }>(`SELECT compatibility_status FROM match_assessments WHERE lot_id = 'lot-a-007'`);
  assert.equal(trace[0].compatibility_status, "incompatible");
  assert.equal((await db.query(`SELECT 1 FROM opportunities WHERE lot_id = 'lot-a-007'`)).length, 0);
});

test("discovery is idempotent", async () => {
  await createGrant(db, B, { recipient_network_id: "net-a", lot_id: null, field_scope: ALL_LOT_FIELDS, allow_identity_disclosure: false, expires_at: null }, NOW);
  const again = await discoverAll(db, NOW);
  assert.equal(again.new_opportunities, 0);
  assert.equal((await oppsOf(A)).length, 2);
});

test("revoking the grant invalidates the opportunity and hides lot details", async () => {
  const { grant_id } = await createGrant(db, B, { recipient_network_id: "net-a", lot_id: "lot-b-018", field_scope: ALL_LOT_FIELDS, allow_identity_disclosure: false, expires_at: null }, NOW);
  const [opp] = await oppsOf(A);
  await revokeGrant(db, B, grant_id, NOW);
  const view = await getOpportunityForActor(db, A, opp.id, NOW);
  assert.equal(view.opportunity.status, "invalidated");
  assert.match(view.opportunity.invalidated_reason!, /revoked/);
  assert.equal(view.lot, null);
  assert.ok(!JSON.stringify(view.checks).includes("1500"));
  const listed = (await listOpportunitiesForActor(db, A, NOW)).find((o) => o.id === opp.id)!;
  assert.deepEqual(listed.checks, []);
  await assert.rejects(decideOpportunity(db, A, opp.id, "shortlisted", "looks good", NOW));
});

test("marking the lot sold invalidates the opportunity at once", async () => {
  await createGrant(db, B, { recipient_network_id: "net-a", lot_id: null, field_scope: ALL_LOT_FIELDS, allow_identity_disclosure: false, expires_at: null }, NOW);
  await setLotStatus(db, B, "lot-b-018", 1, "sold", NOW);
  const opp = (await listOpportunitiesForActor(db, A, NOW)).find((o) => o.lot_id === "lot-b-018")!;
  assert.equal(opp.status, "invalidated");
  assert.match(opp.invalidated_reason!, /sold/);
});

test("a corrected lot gets a new assessment; the old opportunity is superseded", async () => {
  await createGrant(db, B, { recipient_network_id: "net-a", lot_id: null, field_scope: ALL_LOT_FIELDS, allow_identity_disclosure: false, expires_at: null }, NOW);
  await reviewLot(db, B, "lot-b-018", 1, [{ field: "thickness_mm", action: "correct", value: 3.2, note: "typo in offer" }], NOW);
  const all = (await listOpportunitiesForActor(db, A, NOW)).filter((o) => o.lot_id === "lot-b-018");
  assert.ok(all.every((o) => o.status === "invalidated")); // 3.2 mm is out of range → no live opportunity
  const trace = await db.query<{ compatibility_status: string }>(`SELECT compatibility_status FROM match_assessments WHERE lot_id = 'lot-b-018' AND lot_version = 2`);
  assert.equal(trace[0].compatibility_status, "incompatible");
});

test("fields outside the grant scope are withheld from matching and from the buyer's view", async () => {
  const scope = ALL_LOT_FIELDS.filter((f) => f !== "standard_id" && f !== "location_place");
  await createGrant(db, B, { recipient_network_id: "net-a", lot_id: "lot-b-018", field_scope: scope, allow_identity_disclosure: false, expires_at: null }, NOW);
  const [opp] = await oppsOf(A);
  assert.equal(opp.compatibility_status, "insufficient_evidence");
  const view = await getOpportunityForActor(db, A, opp.id, NOW);
  assert.equal(view.lot!.fields.location_place.normalized_value, null);
  assert.ok(!JSON.stringify(view).includes("Busan"));
});

test("other networks cannot read opportunities, documents or guess IDs", async () => {
  await createGrant(db, B, { recipient_network_id: "net-a", lot_id: null, field_scope: ALL_LOT_FIELDS, allow_identity_disclosure: false, expires_at: null }, NOW);
  const [opp] = await oppsOf(A);
  await assert.rejects(getOpportunityForActor(db, C, opp.id, NOW), NotFoundError);
  await assert.rejects(getOpportunityForActor(db, B, opp.id, NOW), NotFoundError); // seller does not see the buyer's demand
  assert.equal((await listOpportunitiesForActor(db, C, NOW)).length, 0);
  await assert.rejects(decideOpportunity(db, C, opp.id, "shortlisted", "x", NOW), NotFoundError);

  await db.query(
    `INSERT INTO source_documents (id, network_id, kind, size_bytes, sha256, parser_version, status, content, created_by) VALUES ('doc-b','net-b','text',1,'h','p','parsed','\\x00','u-b')`,
  );
  await assert.rejects(getDocumentForActor(db, A, "doc-b"), NotFoundError);
  await assert.rejects(revokeGrant(db, A, "grant_does_not_exist", NOW), NotFoundError);
});

test("review decisions need a reason and record the versions they were made on", async () => {
  await createGrant(db, B, { recipient_network_id: "net-a", lot_id: null, field_scope: ALL_LOT_FIELDS, allow_identity_disclosure: false, expires_at: null }, NOW);
  const opp = (await oppsOf(A)).find((o) => o.lot_id === "lot-b-018")!;
  await assert.rejects(decideOpportunity(db, A, opp.id, "shortlisted", "  ", NOW));
  await decideOpportunity(db, A, opp.id, "shortlisted", "Spec and price fit; ask for MTC copy", NOW);
  const [d] = await db.query<{ evidence_version: { lot_version: number; demand_version: number } }>(`SELECT evidence_version FROM review_decisions`);
  assert.equal(d.evidence_version.lot_version, 1);
  assert.equal(d.evidence_version.demand_version, 1);
});

test("engineering-review candidates cannot be silently shortlisted as matches", async () => {
  await createGrant(db, B, { recipient_network_id: "net-a", lot_id: null, field_scope: ALL_LOT_FIELDS, allow_identity_disclosure: false, expires_at: null }, NOW);
  const opp = (await oppsOf(A)).find((o) => o.lot_id === "lot-b-021")!;
  assert.equal(opp.compatibility_status, "engineering_review_required");
  // Allowed to record an engineering review step, but the status stays engineering_review_required.
  await decideOpportunity(db, A, opp.id, "under_review", "Send to QA for substitution review", NOW);
  const view = await getOpportunityForActor(db, A, opp.id, NOW);
  assert.equal(view.compatibility_status, "engineering_review_required");
});

// --- P1 review regressions -------------------------------------------------

const allFields = (over: Partial<Parameters<typeof createGrant>[2]> = {}) => ({
  recipient_network_id: "net-a",
  lot_id: null,
  field_scope: ALL_LOT_FIELDS,
  allow_identity_disclosure: false,
  expires_at: null,
  ...over,
});

test("shared view carries no raw text, quotes, source IDs or reviewer identity", async () => {
  // Unresolved weight whose evidence is the whole line, which also holds the (withheld) price.
  const l = lot({ seller_lot_ref: "B-077" }, { lot_id: "lot-b-077" });
  l.fields.total_kg = {
    raw_value: "22 ton | USD 545 CFR Haiphong",
    normalized_value: null,
    unit: "ton",
    status: "unresolved",
    evidence: [{ source_id: "doc-b", fragment_id: "L9", locator: { kind: "text_span", start: 0, end: 29 }, quote: "22 ton | USD 545 CFR Haiphong" }],
    normalization: null,
    issues: ["ambiguous_ton"],
    review: { status: "confirmed", reviewer_id: "u-b" },
  };
  await insertLot(db, l, null, B.id);
  const scope = ALL_LOT_FIELDS.filter((f) => !f.startsWith("price_") && f !== "incoterm" && f !== "incoterm_place");
  await createGrant(db, B, allFields({ lot_id: "lot-b-077", field_scope: scope }), NOW);
  const opp = (await oppsOf(A)).find((o) => o.lot_id === "lot-b-077")!;
  const view = await getOpportunityForActor(db, A, opp.id, NOW);
  const json = JSON.stringify(view);
  assert.ok(!json.includes("545") && !json.includes("Haiphong USD"), "withheld price must not leak through quotes");
  assert.ok(!json.includes("doc-b") && !json.includes("u-b"), "no source IDs or reviewer identity");
  assert.deepEqual(view.lot!.source_ids, ["owner_private"]);
  assert.equal(view.lot!.fields.grade_raw.evidence[0].locator.kind, "owner_private");
});

test("after revocation neither checks nor score reveal lot values", async () => {
  const { grant_id } = await createGrant(db, B, allFields(), NOW);
  const opps = await oppsOf(A);
  await revokeGrant(db, B, grant_id, NOW);
  for (const o of opps) {
    const view = await getOpportunityForActor(db, A, o.id, NOW);
    assert.equal(view.score, null);
    const json = JSON.stringify(view.checks);
    for (const leak of ["545", "Q235B", "SS400", "18 t", "1500", "hot rolled"]) assert.ok(!json.includes(leak), `leaked ${leak}`);
  }
});

test("an expired grant invalidates on the next read, without any write event", async () => {
  await createGrant(db, B, allFields({ expires_at: new Date(NOW.getTime() + 3_600_000) }), NOW);
  assert.equal((await oppsOf(A)).length, 2);
  const later = new Date(NOW.getTime() + 2 * 3_600_000);
  const listed = await listOpportunitiesForActor(db, A, later);
  const fromB = listed.filter((o) => o.seller_network_id === "net-b");
  assert.ok(fromB.every((o) => o.status === "invalidated" && /revoked or expired/.test(o.invalidated_reason!)));
  assert.ok(fromB.every((o) => o.checks.length === 0 && o.score === null));
});

test("an expired demand invalidates its opportunities and blocks decisions", async () => {
  await db.query(`UPDATE demand_versions SET data = jsonb_set(data, '{expires_at}', to_jsonb($1::text))`, ["2026-10-27T13:00:00.000Z"]);
  await createGrant(db, B, allFields(), NOW);
  const opp = (await oppsOf(A)).find((o) => o.lot_id === "lot-b-018")!;
  const later = new Date("2026-10-27T14:00:00.000Z");
  await assert.rejects(decideOpportunity(db, A, opp.id, "shortlisted", "fits", later));
  const after = (await listOpportunitiesForActor(db, A, later)).find((o) => o.id === opp.id)!;
  assert.equal(after.invalidated_reason, "Demand expired");
});

test("stale stock: the old assessment is not rewritten and a shortlist does not carry over", async () => {
  await createGrant(db, B, allFields(), NOW);
  const opp = (await oppsOf(A)).find((o) => o.lot_id === "lot-b-018")!;
  await decideOpportunity(db, A, opp.id, "shortlisted", "fits", NOW);
  const before = await db.query<{ checks: unknown }>(`SELECT checks FROM match_assessments WHERE id = $1`, [opp.assessment_id]);
  const later = new Date(NOW.getTime() + 72 * 3_600_000);
  const listed = await listOpportunitiesForActor(db, A, later);
  const old = listed.find((o) => o.id === opp.id)!;
  assert.equal(old.status, "invalidated");
  assert.match(old.invalidated_reason!, /reconfirm/);
  const fresh = listed.find((o) => o.lot_id === "lot-b-018" && o.status !== "invalidated")!;
  assert.equal(fresh.compatibility_status, "insufficient_evidence");
  assert.equal(fresh.status, "discovered");
  const afterRows = await db.query<{ checks: unknown }>(`SELECT checks FROM match_assessments WHERE id = $1`, [opp.assessment_id]);
  assert.deepEqual(afterRows[0].checks, before[0].checks);
});

test("engineering-review candidates cannot be shortlisted", async () => {
  await createGrant(db, B, allFields(), NOW);
  const opp = (await oppsOf(A)).find((o) => o.lot_id === "lot-b-021")!;
  await assert.rejects(decideOpportunity(db, A, opp.id, "shortlisted", "cheap", NOW), /engineering review/);
});

test("raw document content is denied to other networks", async () => {
  await db.query(
    `INSERT INTO source_documents (id, network_id, kind, size_bytes, sha256, parser_version, status, content, created_by) VALUES ('doc-b2','net-b','text',1,'h2','p','parsed','\\x00','u-b')`,
  );
  await assert.rejects(getDocumentContentForActor(db, A, "doc-b2"), NotFoundError);
  await assert.rejects(getDocumentContentForActor(db, C, "doc-b2"), NotFoundError);
  assert.ok(await getDocumentContentForActor(db, B, "doc-b2"));
});

test("a corrected value is reviewed but no longer claims source evidence", async () => {
  const { lot: v2 } = await reviewLot(db, B, "lot-b-018", 1, [{ field: "width_mm", action: "correct", value: 1500, note: "confirmed by phone" }], NOW);
  assert.equal(v2.fields.width_mm.status, "user_corrected");
  assert.deepEqual(v2.fields.width_mm.evidence, []);
  assert.equal(v2.fields.width_mm.raw_value, null);
});
