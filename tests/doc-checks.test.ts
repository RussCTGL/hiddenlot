import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ForbiddenError, NotFoundError, type Actor } from "@/auth/access";
import type { Db } from "@/db/client";
import { fragmentText } from "@/ingestion/text-fragments";
import { seedDemo } from "@/seed/demo";
import { acceptOffer, acceptSuggestions, buildDigest, listRequestsForSeller, sendOffer } from "@/workflow/deals";
import { checkDocument, docIssues, orderFacts, type OrderFacts } from "@/workflow/doc-templates";
import { addDealFile, completeStep, createProforma, DocumentMismatchError, getDealFile, getOrderView } from "@/workflow/orders";
import { freshDb } from "./db";

// Order documents are checked against their templates: every value quotes its
// line, nothing missing is guessed, and a step whose document does not match
// the order is only completed with a reason both sides see.

let db: Db;
const NOW = new Date("2026-10-28T07:00:00.000Z");
const A: Actor = { id: "u-ana", network_id: "net-a", role: "trader" };
const B: Actor = { id: "u-bo", network_id: "net-b", role: "trader" };
const C: Actor = { id: "u-chen", network_id: "net-c", role: "trader" };
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const text = (filename: string, lines: string[]) => ({ filename, bytes: new TextEncoder().encode(lines.join("\n")) });

before(async () => {
  db = await freshDb();
});
after(async () => db.close());
beforeEach(async () => {
  await seedDemo(db, NOW);
});

const sampleDeal = async () => (await db.query<{ id: string }>(`SELECT id FROM deals WHERE lot_id = 'lot-b-044' AND buyer_network_id = 'net-a'`))[0].id;

const FACTS: OrderFacts = {
  buyer: "Network A",
  seller: "Network B",
  lotRef: "B-044",
  grade: "Q235B",
  standard: "GB/T 700",
  thickness_mm: 2.75,
  width_mm: 1250,
  lot_t: 24,
  heats: null,
  quote: { price: "498", currency: "USD", incoterm: "FOB Tianjin", valid_until: "2026-11-04", quantity_t: 24 },
  proforma: null,
  today: "2026-10-28",
};

test("a template check: matches, differs with the quoted line, and not found stays not found", () => {
  const lines = [
    "PROFORMA INVOICE",
    "Seller: Network B (fictional)    Buyer: Network A (fictional)",
    "Lot ref: B-044",
    "Grade: Q235B GB/T 700",
    "Size: 2.75 x 1250 mm",
    "Quantity: 24 MT",
    "Unit price: USD 489/MT",
    "Incoterm: FOB Tianjin",
    "Amount: USD 11,952.00",
    "Payment terms: Unknown",
  ];
  const c = checkDocument("proforma", fragmentText(lines.join("\n")), FACTS, NOW);
  const f = Object.fromEntries(c.fields.map((x) => [x.key, x]));
  assert.equal(f.seller.status, "ok");
  assert.equal(f.buyer.status, "ok"); // two labels on one line are read apart
  assert.equal(f.buyer.found, "Network A (fictional)");
  assert.equal(f.price.status, "differs");
  assert.equal(f.price.expected, "USD 498/MT");
  assert.deepEqual(f.price.quote, { at: "L7", text: "Unit price: USD 489/MT" });
  assert.equal(f.currency.status, "ok"); // read from the price line, quoting it
  assert.equal(f.currency.quote?.at, "L7");
  assert.equal(f.payment_terms.status, "missing"); // "Unknown" is not a value
  assert.equal(f.validity.status, "missing");
  assert.equal(f.validity.required, false);
  assert.deepEqual(docIssues(c).map((x) => x.key), ["price", "payment_terms"]);
});

test("cross-document checks: the L/C amount follows the proforma, the B/L weight stays within tolerance", () => {
  const facts = { ...FACTS, proforma: { file: "PI.pdf", amount: "USD 12,000.00", quantity: "24.5 t" } };
  const lc = checkDocument("payment", fragmentText("L/C no.: X1\nApplicant: Network A\nBeneficiary: Network B\nAmount: USD 11,952.00\nGoods: lot B-044\nExpiry: 10 Dec 2026"), facts, NOW);
  const amount = lc.fields.find((x) => x.key === "amount")!;
  assert.equal(amount.status, "differs");
  assert.equal(amount.expected, "USD 12,000.00");
  assert.match(amount.source!, /proforma/);
  assert.equal(lc.fields.find((x) => x.key === "expiry")!.status, "ok");
  const bl = (w: string) => checkDocument("bill_of_lading", fragmentText(`Gross weight: ${w}\nPort of loading: Xingang, Tianjin`), facts, NOW).fields;
  assert.equal(bl("25,600 kg").find((x) => x.key === "weight")!.status, "ok"); // 24.5 t + 4.5 %
  assert.equal(bl("26 t").find((x) => x.key === "weight")!.status, "differs");
  assert.equal(bl("26").find((x) => x.key === "weight")!.status, "differs"); // no unit, no reading
  assert.equal(bl("26 t").find((x) => x.key === "pol")!.status, "ok");
});

test("the generated proforma passes its own check, and the facts come from the order", async () => {
  const s = (await buildDigest(db, A, NOW)).forward.find((x) => x.lotRef === "B-018")!;
  await acceptSuggestions(db, A, [s.key], NOW);
  const id = (await listRequestsForSeller(db, B)).find((r) => r.lotRef === "B-018")!.dealId;
  await sendOffer(db, B, id, { price: "540", currency: "USD", incoterm: "CFR Haiphong", valid_until: "2026-11-05", quantity_t: 18 }, hours(1));
  await acceptOffer(db, A, id, hours(2));
  await completeStep(db, B, id, "confirmed", "", null, hours(3));
  await assert.rejects(createProforma(db, A, id, "L/C at sight", hours(4)), /seller does this step/);
  await assert.rejects(createProforma(db, C, id, "L/C at sight", hours(4)), NotFoundError);
  await assert.rejects(createProforma(db, B, id, " ", hours(4)), /payment terms/);
  const check = await createProforma(db, B, id, "Irrevocable L/C at sight", hours(4));
  assert.ok(check?.readable && check.generated);
  assert.deepEqual(docIssues(check), []);
  assert.equal(check!.fields.find((f) => f.key === "amount")!.found, "USD 9,720.00");
  const v = await getOrderView(db, A, id); // the buyer sees the same check
  const doc = v.steps.find((x) => x.id === "contract")!.doc!;
  assert.match(doc.filename, /^Proforma PI-B018-26\.pdf$/);
  assert.deepEqual(docIssues(doc.check), []);
  const pdf = new TextDecoder().decode((await getDealFile(db, A, id, doc.id)).bytes);
  assert.match(pdf, /SYNTHETIC DEMO DOCUMENT/);
  await completeStep(db, B, id, "contract", "", null, hours(5));
});

test("the seeded MTC differs from the lot: both sides see it, completing needs a reason, the buyer's news says so", async () => {
  const id = await sampleDeal();
  for (const who of [A, B]) {
    const mtc = (await getOrderView(db, who, id)).steps.find((s) => s.id === "mtc")!;
    assert.equal(mtc.next, true);
    assert.deepEqual(docIssues(mtc.doc!.check).map((f) => [f.key, f.status, f.expected, f.found]), [["size", "differs", "2.75 x 1250 mm", "2.70 x 1250 mm"]]);
  }
  const done = (await getOrderView(db, A, id)).steps.filter((s) => s.done);
  assert.deepEqual(done.map((s) => [s.id, docIssues(s.doc?.check ?? null).length]), [["confirmed", 0], ["contract", 0], ["payment", 0]]);
  const news = (await buildDigest(db, A, NOW)).risks.find((s) => s.dealId === id)!;
  assert.equal(news.badge, "Document does not match the order");
  assert.match(news.reason, /Dimensions: expected 2\.75 x 1250 mm, found 2\.70 x 1250 mm/);

  await assert.rejects(completeStep(db, B, id, "mtc", "", null, hours(1)), DocumentMismatchError);
  await assert.rejects(completeStep(db, B, id, "mtc", "", null, hours(1), "   "), /complete anyway and give a reason/);
  await completeStep(db, B, id, "mtc", "", null, hours(1), "Mill re-measured: 2.75 mm, corrected MTC to follow");
  const step = (await getOrderView(db, A, id)).steps.find((s) => s.id === "mtc")!;
  assert.equal(step.override, "Mill re-measured: 2.75 mm, corrected MTC to follow");
  const after = (await buildDigest(db, A, hours(1))).risks.find((s) => s.dealId === id)!;
  assert.match(after.reason, /Completed although the mill test certificate does not match the order .*Reason: Mill re-measured/);
});

test("a corrected upload clears the check; a mismatching one is refused without a reason", async () => {
  const id = await sampleDeal();
  const good = await addDealFile(db, B, id, text("MTC corrected.txt", ["Certificate no.: MTC-26-1187-R1", "Grade: Q235B GB/T 700", "Heat no.: 26-1187", "Dimensions: 2.75 x 1250 mm", "Weight: 24,060 kg", "Chemical composition: C 0.16", "Mechanical results: yield 275 MPa"]), hours(1), "mtc");
  assert.deepEqual(docIssues(good), []);
  await completeStep(db, B, id, "mtc", "", null, hours(2)); // the latest document on the step is the one that counts
  // A B/L for the wrong consignee and too much weight, sent with the step itself, is refused and not stored.
  const bl = text("BL.csv", ["B/L no.,Shipper,Consignee,Vessel,Port of loading,Port of discharge,Goods description,Gross weight,Shipped on board", "TJN-778812,Network B,Network C,MV Fictional Star,Tianjin,Haiphong,HRC Q235B GB/T 700,28.2 t,2026-10-30"]);
  await assert.rejects(completeStep(db, B, id, "shipped", "", bl, hours(3)), /Consignee \/ notify: expected Network A, found Network C; Gross weight: expected 24 t ± 5%, found 28\.2 t/);
  assert.equal((await getOrderView(db, A, id)).files.some((f) => f.filename === "BL.csv"), false);
  // An image is kept but not read: every field is "not found", never guessed.
  const scan = await addDealFile(db, B, id, { filename: "BL scan.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }, hours(3), "shipped");
  assert.equal(scan!.readable, false);
  assert.ok(scan!.fields.every((f) => f.status === "missing" && f.found === null && f.quote === null));
});

test("only the two parties attach and read step documents, and only the side whose step is next", async () => {
  const id = await sampleDeal();
  const mtc = text("MTC.txt", ["Dimensions: 2.75 x 1250 mm"]);
  await assert.rejects(addDealFile(db, C, id, mtc, hours(1), "mtc"), NotFoundError);
  await assert.rejects(addDealFile(db, A, id, mtc, hours(1), "mtc"), /seller does this step/);
  await assert.rejects(addDealFile(db, B, id, mtc, hours(1), "shipped"), ForbiddenError);
  const fileId = (await getOrderView(db, B, id)).steps.find((s) => s.id === "mtc")!.doc!.id;
  await assert.rejects(getDealFile(db, C, id, fileId), NotFoundError);
  assert.ok((await getDealFile(db, A, id, fileId)).bytes.length > 0);
  // A file shared outside the steps is not checked.
  assert.equal(await addDealFile(db, A, id, text("note.txt", ["Wrap for sea freight"]), hours(1)), null);
});

test("facts come only from what the lot states; unknown stays null", () => {
  const f = orderFacts(null, "B-044", null, "Network A", "Network B", null, null, NOW);
  assert.equal(f.grade, null);
  assert.equal(f.lot_t, null);
  const c = checkDocument("mtc", fragmentText("Dimensions: 3 x 1500 mm"), f, NOW);
  assert.equal(c.fields.find((x) => x.key === "size")!.status, "ok"); // nothing to compare against: found, not judged
  assert.equal(c.fields.find((x) => x.key === "size")!.expected, null);
});

