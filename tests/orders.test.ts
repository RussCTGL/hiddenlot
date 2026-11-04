import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { NotFoundError, type Actor } from "@/auth/access";
import type { Db } from "@/db/client";
import { seedDemo } from "@/seed/demo";
import { acceptOffer, acceptSuggestions, buildDigest, getDealViewForActor, listDealsForActor, listRequestsForSeller, sendOffer } from "@/workflow/deals";
import { addDealFile, completeStep, declineOrder, getDealFile, getOrderView, listOrdersForSeller } from "@/workflow/orders";
import { tinyPdf } from "@/lib/tiny-pdf";
import { freshDb } from "./db";

// After the offer: the order both sides share, its steps and files (demo seed with the sample order).

let db: Db;
const NOW = new Date("2026-10-28T07:00:00.000Z");
const A: Actor = { id: "u-ana", network_id: "net-a", role: "trader" };
const B: Actor = { id: "u-bo", network_id: "net-b", role: "trader" };
const C: Actor = { id: "u-chen", network_id: "net-c", role: "trader" };
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
// An MTC that matches the order (the seeded one shows 2.70 mm on a 2.75 mm lot).
const pdf = {
  filename: "MTC B-044.pdf",
  bytes: tinyPdf("MILL TEST CERTIFICATE", [
    "Certificate no.: MTC-26-1190",
    "Grade / standard: Q235B GB/T 700-2006",
    "Heat numbers: 26-1187",
    "Dimensions: 2.75 x 1250 mm",
    "Weight: 24.1 t",
    "Chemical composition: C 0.16 Mn 0.52",
    "Mechanical results: yield 275 MPa",
  ]),
};

before(async () => {
  db = await freshDb();
});
after(async () => db.close());
beforeEach(async () => {
  await seedDemo(db, NOW);
});

const sampleDeal = async () => (await db.query<{ id: string }>(`SELECT id FROM deals WHERE lot_id = 'lot-b-044' AND buyer_network_id = 'net-a'`))[0].id;

test("the demo starts with an order under way: B-044 sold to Network A, three files shared, MTC is the seller's turn", async () => {
  const id = await sampleDeal();
  const a = await getOrderView(db, A, id);
  const b = await getOrderView(db, B, id);
  assert.equal(a.stage, "ordered");
  assert.deepEqual(a.steps.filter((s) => s.done).map((s) => s.id), ["confirmed", "contract", "payment"]);
  assert.equal(a.steps.find((s) => s.next)?.id, "mtc");
  assert.equal(a.waitingOn, "them");
  assert.equal(b.waitingOn, "you");
  assert.deepEqual(a.files.map((f) => f.filename).sort(), ["LC-A-26-0457.pdf", "MTC 26-1187.pdf", "Proforma PI-B044-26.pdf"]);
  // The buyer still reads the lot it bought, though the lot is sold.
  const v = await getDealViewForActor(db, A, id, NOW);
  assert.match(v.title, /Q235B/);
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM lots WHERE id = 'lot-b-044'`))[0].status, "sold");
  // B-044 is no longer a candidate for anyone; the seller sees the order with its turn.
  assert.ok(!(await buildDigest(db, A, NOW)).forward.some((s) => s.lotRef === "B-044"));
  const orders = await listOrdersForSeller(db, B);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].yourTurn, true);
  assert.equal(orders[0].next, "Mill test certificate shared");
  // A shared file is readable by both sides and nobody else.
  const f = await getDealFile(db, B, id, a.files.find((x) => x.filename.startsWith("LC"))!.id);
  assert.match(new TextDecoder().decode(f.bytes.subarray(0, 8)), /^%PDF-1\.4/);
  await assert.rejects(getDealFile(db, C, id, a.files[0].id), NotFoundError);
});

test("each side does its own steps in order; the buyer sees the seller's step at once; receipt completes the order", async () => {
  const id = await sampleDeal();
  await assert.rejects(completeStep(db, A, id, "mtc", "", pdf, hours(1)), /seller does this step/);
  await assert.rejects(completeStep(db, B, id, "shipped", "", null, hours(1)), /not next/);
  await assert.rejects(completeStep(db, C, id, "mtc", "", pdf, hours(1)), NotFoundError);
  await completeStep(db, B, id, "mtc", "Heat 26-1187", pdf, hours(1));
  const news = (await buildDigest(db, A, hours(1))).risks.find((s) => s.dealId === id);
  assert.equal(news?.action, "seen");
  assert.match(news!.reason, /Network B: Mill test certificate shared \(Heat 26-1187\), with MTC B-044\.pdf/);
  await completeStep(db, B, id, "shipped", "B/L TJN-778812", null, hours(2));
  await completeStep(db, A, id, "received", "", null, hours(3));
  const v = await getOrderView(db, A, id);
  assert.equal(v.stage, "won");
  assert.equal(v.waitingOn, null);
  assert.equal((await listDealsForActor(db, A, hours(3))).find((d) => d.deal.id === id)?.deal.stage, "won");
});

test("files can be shared both ways during the deal; checked by type and size", async () => {
  const id = await sampleDeal();
  await addDealFile(db, A, id, { filename: "packing instructions.txt", bytes: new TextEncoder().encode("Wrap coils for sea freight.") }, hours(1));
  await assert.rejects(addDealFile(db, B, id, { filename: "run.exe", bytes: new Uint8Array([1]) }, hours(1)), /Only/);
  await assert.rejects(addDealFile(db, C, id, pdf, hours(1)), NotFoundError);
  assert.equal((await getOrderView(db, B, id)).files.length, 4);
  assert.equal((await buildDigest(db, A, hours(1))).risks.find((s) => s.dealId === id), undefined); // her own file is no news to her
});

test("an accepted offer waits for the seller, who can confirm or decline", async () => {
  const s = (await buildDigest(db, A, NOW)).forward.find((x) => x.lotRef === "B-018")!;
  await acceptSuggestions(db, A, [s.key], NOW);
  const id = (await listRequestsForSeller(db, B)).find((r) => r.lotRef === "B-018")!.dealId;
  await assert.rejects(acceptOffer(db, A, id, NOW), /no offer/);
  await sendOffer(db, B, id, { price: "540", currency: "USD", incoterm: "CFR Haiphong", valid_until: null, quantity_t: 18 }, hours(1));
  await acceptOffer(db, A, id, hours(2));
  assert.equal((await getOrderView(db, B, id)).steps.find((x) => x.next)?.id, "confirmed");
  await assert.rejects(declineOrder(db, A, id, "no", hours(3)), /Only the seller/);
  await declineOrder(db, B, id, "Sold elsewhere", hours(3));
  assert.equal((await getOrderView(db, A, id)).stage, "lost");
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM lots WHERE id = 'lot-b-018'`))[0].status, "published");
});
