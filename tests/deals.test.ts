import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { NotFoundError, type Actor } from "@/auth/access";
import type { Db } from "@/db/client";
import { freshDb } from "./db";
import { seedDemo } from "@/seed/demo";
import { ALL_LOT_FIELDS, createGrant, reconfirmLot, revokeGrant, setLotStatus } from "@/workflow/actions";
import { acceptSuggestions, allSuggestions, buildDigest, closeDeal, declineSuggestion, getDealViewForActor, listDealsForActor, moveDeal, recordQuote } from "@/workflow/deals";

// Daily digest and deal tracking on the synthetic demo (plan §7.1 story).

let db: Db;
const NOW = new Date("2026-10-28T07:00:00.000Z");
const A: Actor = { id: "u-ana", network_id: "net-a", role: "trader" };
const B: Actor = { id: "u-bo", network_id: "net-b", role: "trader" };
const C: Actor = { id: "u-chen", network_id: "net-c", role: "trader" };
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const refs = (xs: { ref: string }[]) => xs.map((x) => x.ref.split(" · ")[0]).sort();

before(async () => {
  db = await freshDb();
});
after(async () => db.close());
beforeEach(async () => {
  await seedDemo(db, NOW);
});

test("the digest sorts the demo into move forward, needs an answer, engineering review and ruled out", async () => {
  const d = await buildDigest(db, A, NOW);
  assert.deepEqual(refs(d.forward), ["Lot B-018", "Lot B-044"]);
  assert.deepEqual(refs(d.ask), ["Lot A-009", "Lot C-104", "Lot C-105"]);
  assert.deepEqual(d.engineering.map((e) => e.lotRef).sort(), ["B-021", "C-101", "C-102"]);
  assert.equal(d.risks.length, 0);
  assert.equal(d.stats.deals, 0);

  const c104 = d.ask.find((s) => s.ref.startsWith("Lot C-104"))!;
  assert.match(c104.question!, /MTC/);
  assert.match(c104.draft!, /^Hello, for lot C-104/);
  const a009 = d.ask.find((s) => s.ref.startsWith("Lot A-009"))!;
  assert.match(a009.question!, /1\) Is it prime or secondary.*2\) Is an MTC available/);
  assert.doesNotMatch(a009.draft!, /^Hello/); // own network: a note to a colleague
  const b018 = d.forward.find((s) => s.ref.startsWith("Lot B-018"))!;
  assert.match(b018.draft!, /copy of the MTC/); // the MTC is only the seller's claim
});

test("accept all turns suggestions into tracked deals; nothing is sent", async () => {
  const d = await buildDigest(db, A, NOW);
  const r = await acceptSuggestions(db, A, allSuggestions(d).map((s) => s.key), NOW);
  assert.equal(r.done, 5);
  const deals = await listDealsForActor(db, A, NOW);
  assert.deepEqual(deals.map((x) => x.deal.stage).sort(), ["quote_requested", "quote_requested", "waiting", "waiting", "waiting"]);
  const after = await buildDigest(db, A, NOW);
  assert.equal(after.forward.length + after.ask.length, 0);
  assert.equal(after.stats.deals, 5);
  // Accepting the same keys again does nothing: they no longer exist.
  assert.equal((await acceptSuggestions(db, A, allSuggestions(d).map((s) => s.key), NOW)).done, 0);
});

test("two days later the digest flags stale stock and silent sellers; reconfirming clears it", async () => {
  await acceptSuggestions(db, A, allSuggestions(await buildDigest(db, A, NOW)).map((s) => s.key), NOW);
  const later = hours(50);
  const d = await buildDigest(db, A, later);
  const b018 = d.risks.find((s) => s.ref.startsWith("Lot B-018"))!;
  assert.equal(b018.action, "reconfirm");
  assert.match(b018.badge!, /Stock not reconfirmed · 80 h/);

  const lot = (await db.query<{ current_version: number }>(`SELECT current_version FROM lots WHERE id = 'lot-b-018'`))[0];
  await reconfirmLot(db, B, "lot-b-018", lot.current_version, later);
  const d2 = await buildDigest(db, A, later);
  const again = d2.risks.find((s) => s.ref.startsWith("Lot B-018"));
  assert.notEqual(again?.action, "reconfirm");
});

test("a sold lot or ended sharing closes the deal as lost without lot details", async () => {
  await acceptSuggestions(db, A, allSuggestions(await buildDigest(db, A, NOW)).map((s) => s.key), NOW);
  const lot = (await db.query<{ current_version: number }>(`SELECT current_version FROM lots WHERE id = 'lot-b-018'`))[0];
  await setLotStatus(db, B, "lot-b-018", lot.current_version, "sold", hours(1));
  const grants = await db.query<{ id: string }>(`SELECT id FROM sharing_grants WHERE owner_network_id = 'net-c' AND revoked_at IS NULL`);
  for (const g of grants) await revokeGrant(db, C, g.id, hours(1));

  const deals = await listDealsForActor(db, A, hours(2));
  const lost = deals.filter((x) => x.deal.stage === "lost");
  assert.deepEqual(lost.map((x) => x.deal.closed_reason).sort(), ["Lot is sold", "Sharing ended", "Sharing ended"]);
  for (const x of lost.filter((l) => l.deal.closed_reason === "Sharing ended")) {
    assert.equal(x.title, "Lot details hidden");
    const v = await getDealViewForActor(db, A, x.deal.id, hours(2));
    assert.equal(v.lot, null);
    assert.ok(!JSON.stringify(v).includes("Kaohsiung"));
  }
});

test("quote, negotiation and close; won needs a recorded offer", async () => {
  await acceptSuggestions(db, A, allSuggestions(await buildDigest(db, A, NOW)).map((s) => s.key), NOW);
  const deal = (await listDealsForActor(db, A, NOW)).find((x) => x.ref.startsWith("B-044"))!.deal;
  await assert.rejects(closeDeal(db, A, deal.id, "won", "agreed", NOW), /offer/);
  await recordQuote(db, A, deal.id, { price: "495", currency: "USD", incoterm: "FOB Tianjin", valid_until: "2026-10-28", quantity_t: 24 }, NOW);
  await moveDeal(db, A, deal.id, "negotiating", NOW);
  const v = await getDealViewForActor(db, A, deal.id, NOW);
  assert.equal(v.deal.stage, "negotiating");
  assert.ok(v.events.length >= 3);
  // The next day the offer has expired: a risk, while the stock is still fresh.
  const risk = (await buildDigest(db, A, hours(24))).risks.find((s) => s.dealId === deal.id);
  assert.equal(risk?.action, "requote");
  await closeDeal(db, A, deal.id, "won", "Agreed at USD 495 FOB", hours(24));
  assert.equal((await getDealViewForActor(db, A, deal.id, hours(24))).deal.stage, "won");
});

test("deals are the buyer's alone", async () => {
  await acceptSuggestions(db, A, allSuggestions(await buildDigest(db, A, NOW)).map((s) => s.key), NOW);
  const deal = (await listDealsForActor(db, A, NOW))[0].deal;
  await assert.rejects(getDealViewForActor(db, B, deal.id, NOW), NotFoundError);
  await assert.rejects(recordQuote(db, B, deal.id, { price: "1", currency: "USD", incoterm: "FOB", valid_until: null, quantity_t: null }, NOW), NotFoundError);
  assert.equal((await listDealsForActor(db, B, NOW)).length, 0);
});

test("drafts use only shared fields: a withheld price never appears", async () => {
  // Network B re-shares with A without prices; the newest grant decides the scope.
  await createGrant(db, B, { recipient_network_id: "net-a", lot_id: "lot-b-018", field_scope: ALL_LOT_FIELDS.filter((f) => f !== "price_amount"), allow_identity_disclosure: false, expires_at: null }, NOW);
  const s = (await buildDigest(db, A, NOW)).forward.find((x) => x.ref.startsWith("Lot B-018"))!;
  assert.ok(s.draft);
  assert.ok(!s.draft!.includes("545"), s.draft!);
});

test("dismiss removes a candidate; not now hides a risk until tomorrow", async () => {
  const d = await buildDigest(db, A, NOW);
  assert.ok(await declineSuggestion(db, A, d.forward[0].key, NOW));
  assert.equal((await buildDigest(db, A, NOW)).forward.length, 1);
  await acceptSuggestions(db, A, allSuggestions(await buildDigest(db, A, NOW)).map((s) => s.key), NOW);
  const risk = (await buildDigest(db, A, hours(50))).risks[0];
  assert.ok(await declineSuggestion(db, A, risk.key, hours(50)));
  assert.ok(!(await buildDigest(db, A, hours(50))).risks.some((r) => r.key === risk.key));
});

test("map places come from shared fields only: a withheld stock location is never drawn", async () => {
  const d = await buildDigest(db, A, NOW);
  const where = (ref: string) => allSuggestions(d).find((s) => s.lotRef === ref)!.where;
  // Network B does not share where its stock sits: B-018 is shown at the port it is delivered to, B-044 at its loading port.
  assert.deepEqual([where("B-018")?.kind, where("B-018")?.name], ["delivered", "Haiphong"]);
  assert.deepEqual([where("B-044")?.kind, where("B-044")?.name], ["ships_from", "Tianjin"]);
  // Network C shares everything: C-104 is drawn where the stock is.
  assert.deepEqual([where("C-104")?.kind, where("C-104")?.name], ["stock", "Kaohsiung"]);
  // B-018 sits in Busan, which Network A must not learn from the digest.
  assert.ok(!JSON.stringify(d).includes("Busan"));
});

test("moving the clock past the freshness window and back restores the candidates", async () => {
  const before = await buildDigest(db, A, NOW);
  await buildDigest(db, A, hours(24 * 7)); // a week later: every lot is stale
  const back = await buildDigest(db, A, NOW);
  assert.deepEqual(refs(back.forward), refs(before.forward));
  assert.deepEqual(refs(back.ask), refs(before.ask));
  // One open opportunity per pair, and none carries a decision over.
  const dup = await db.query(`SELECT demand_id, lot_id FROM opportunities WHERE status <> 'invalidated' GROUP BY 1, 2 HAVING count(*) > 1`);
  assert.equal(dup.length, 0);
});

test("requesting information on an opportunity tracks the open question, not the typed reason", async () => {
  const { openQuestions } = await import("@/workflow/deals");
  const c104 = (await buildDigest(db, A, NOW)).ask.find((s) => s.lotRef === "C-104")!;
  assert.equal(await openQuestions(db, A, c104.oppId!, NOW), "Is an MTC available for this lot?");
});

test("a Houston buyer gets the same digest from US, Mexican and European stock, in the seller's units", async () => {
  const D: Actor = { id: "u-dana", network_id: "net-d", role: "trader" };
  const d = await buildDigest(db, D, NOW);
  assert.deepEqual(refs(d.forward), ["Lot E-301", "Lot E-412"]);
  assert.deepEqual(refs(d.ask), ["Lot D-204", "Lot E-305"]);
  assert.deepEqual(d.engineering.map((e) => e.lotRef), ["E-410"]);
  assert.deepEqual(d.ruledOut.map((e) => e.lotRef).sort(), ["D-201", "E-309"]);

  const where = (ref: string) => allSuggestions(d).find((s) => s.lotRef === ref)!.where;
  assert.deepEqual([where("E-301")?.name, where("E-305")?.name, where("E-412")?.name], ["New Orleans", "Altamira", "Rotterdam"]);
  assert.equal(allSuggestions(d).find((s) => s.lotRef === "E-412")!.destination?.name, "Houston");

  // The seller wrote inches and pounds; the draft reads them back, with the metric value the rules used.
  const e301 = d.forward.find((s) => s.lotRef === "E-301")!;
  assert.match(e301.draft!, /0\.118 × 60 in, 39,683 lbs \/ 18 t, FOB New Orleans/);
  // "20 tons" is never guessed: the seller is asked which ton.
  assert.equal(d.ask.find((s) => s.lotRef === "E-305")!.question, "Is the weight in metric tonnes or short tons?");

  // Network A sees none of it.
  assert.ok(!JSON.stringify(await buildDigest(db, A, NOW)).match(/E-3|E-4|D-20|Houston/));
});
