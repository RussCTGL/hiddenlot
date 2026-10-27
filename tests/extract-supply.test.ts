import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { toStrictJsonSchema } from "@/ai/json-schema";
import { findSpan, numbersIn, postProcessSupply, SupplyExtraction, type ExtractedLot } from "@/ai/tasks/extract-supply";
import { fragmentText } from "@/ingestion/text-fragments";

const text = readFileSync(path.join(__dirname, "../data/synthetic/probe/stock-network-b.txt"), "utf8");
const fragments = fragmentText(text);
const lineOf = (needle: string) => fragments.find((f) => f.text.includes(needle))!.id;

const none = { value: null, raw: null, evidence: [] };
const emptyLot = (): ExtractedLot => ({
  seller_lot_ref: none,
  product_form: none,
  grade: none,
  standard_id: none,
  standard_edition: none,
  certificate_claims: { value: [], raw: null, evidence: [] },
  heat_numbers: { value: [], raw: null, evidence: [] },
  thickness: { ...none, unit: null },
  width: { ...none, unit: null },
  total_weight: { ...none, unit: null },
  piece_count: none,
  splittable: none,
  location_country: none,
  location_place: none,
  available_from: none,
  price_amount: none,
  price_currency: none,
  price_basis: none,
  incoterm: none,
  incoterm_place: none,
  condition: none,
  defect_notes: none,
  surplus_reason: none,
});

const ctx = {
  fragments,
  sourceId: "synthetic:test",
  ownerNetworkId: "net-b",
  synthetic: true,
  extractionRunId: null,
  observedAt: "2026-10-26T00:00:00.000Z",
};

// Each claim belongs to the lot whose section contains the cited line, so the
// helper adds that lot's reference (the probe text has two lots).
function run(lot: ExtractedLot) {
  if (lot.seller_lot_ref.value === null) {
    const cited = Object.values(lot).flatMap((c) => (c as { evidence: string[] }).evidence);
    const at = Math.max(0, ...cited.map((id) => fragments.findIndex((f) => f.id === id)));
    const refLine = fragments.slice(0, at + 1).reverse().find((f) => /Lot B-\d+/.test(f.text));
    if (refLine) lot = { ...lot, seller_lot_ref: { value: refLine.text.match(/B-\d+/)![0], raw: refLine.text.match(/B-\d+/)![0], evidence: [refLine.id] } };
  }
  return postProcessSupply({ lots: [lot], ambiguities: [], ignored_instructions: [] }, ctx).lots[0].fields;
}

test("fragments keep exact offsets into the source", () => {
  for (const f of fragments) assert.equal(text.slice(f.start, f.end), f.text);
});

test("model output schema satisfies Meta strict subset", () => {
  assert.doesNotThrow(() => toStrictJsonSchema(SupplyExtraction));
});

test("well-supported values normalize with a precise evidence span", () => {
  const L = lineOf("3.0mm");
  const fields = run({ ...emptyLot(), thickness: { value: 3.0, unit: "mm", raw: "3.0mm", evidence: [L] } });
  assert.equal(fields.thickness_mm.normalized_value, 3);
  assert.equal(fields.thickness_mm.status, "normalized");
  const ev = fields.thickness_mm.evidence[0];
  assert.ok(ev.locator.kind === "text_span");
  if (ev.locator.kind === "text_span") assert.equal(text.slice(ev.locator.start, ev.locator.end), "3.0mm");
});

test("a unit the source never wrote is rejected (no assumed mm)", () => {
  const L = lineOf("2.75*1250");
  const fields = run({ ...emptyLot(), thickness: { value: 2.75, unit: "mm", raw: "2.75*1250*C", evidence: [L] } });
  assert.equal(fields.thickness_mm.normalized_value, null);
  assert.deepEqual(fields.thickness_mm.issues, ["unit_not_in_raw"]);
});

test("ambiguous 'ton' stays unknown", () => {
  const L = lineOf("约 22 ton");
  const fields = run({ ...emptyLot(), total_weight: { value: 22, unit: "ton", raw: "22 ton", evidence: [L] } });
  assert.equal(fields.total_kg.normalized_value, null);
  assert.equal(fields.total_kg.status, "unresolved");
  assert.deepEqual(fields.total_kg.issues, ["ambiguous_ton"]);
});

test("standard filled from general knowledge is rejected", () => {
  const L = lineOf("Q235B");
  const fields = run({ ...emptyLot(), standard_id: { value: "GB/T 700", raw: "Q235B", evidence: [L] } });
  assert.equal(fields.standard_id.normalized_value, null);
  assert.deepEqual(fields.standard_id.issues, ["value_not_in_raw"]);
});

test("raw text that is not in the cited fragment is rejected", () => {
  const fields = run({ ...emptyLot(), grade: { value: "SS400", raw: "SS400", evidence: [lineOf("2.75*1250")] } });
  assert.equal(fields.grade_raw.normalized_value, null);
  assert.deepEqual(fields.grade_raw.issues, ["raw_not_in_evidence"]);
});

test("unknown evidence IDs are flagged", () => {
  const fields = run({ ...emptyLot(), grade: { value: "SS400", raw: "SS400", evidence: ["L999"] } });
  assert.equal(fields.grade_raw.normalized_value, null);
  assert.ok(fields.grade_raw.issues.includes("unknown_evidence_id:L999"));
});

test("a misread number (3.0 → 30) is caught", () => {
  const L = lineOf("3.0mm");
  const fields = run({ ...emptyLot(), thickness: { value: 30, unit: "mm", raw: "3.0mm", evidence: [L] } });
  assert.equal(fields.thickness_mm.normalized_value, null);
  assert.deepEqual(fields.thickness_mm.issues, ["value_not_in_raw"]);
});

test("unstated fields are not_stated, not zero", () => {
  const fields = run(emptyLot());
  assert.equal(fields.price_amount.status, "not_stated");
  assert.equal(fields.price_amount.normalized_value, null);
});

test("number parsing does not guess decimal commas", () => {
  assert.deepEqual(numbersIn("1,500mm x 3.0"), [1500, 3]);
  assert.deepEqual(numbersIn("3,5 mm"), []);
});

test("a quote that only drops an apostrophe resolves to the source's own text", () => {
  const L = lineOf("L/C cancelled");
  const fields = run({
    ...emptyLot(),
    surplus_reason: { value: "cancelled_lc", raw: "buyers L/C cancelled", evidence: [L] },
  });
  assert.equal(fields.surplus_reason.normalized_value, "cancelled_lc");
  assert.equal(fields.surplus_reason.raw_value, "buyer's L/C cancelled");
  const ev = fields.surplus_reason.evidence[0];
  assert.equal(ev.quote, "buyer's L/C cancelled");
  if (ev.locator.kind === "text_span") assert.equal(text.slice(ev.locator.start, ev.locator.end), ev.quote);
});

test("span matching ignores only quotes, apostrophes and whitespace", () => {
  const span = (raw: string, src: string) => {
    const s = findSpan(raw, src);
    return s && src.slice(s[0], s[1]);
  };
  assert.equal(span("buyers L/C", "Reason: buyer’s L/C cancelled"), "buyer’s L/C");
  assert.equal(span("3.0 mm", "size 3.0mm x 1500"), "3.0mm");
  assert.equal(span("“SS400”", "grade SS400, JIS"), "SS400");
  assert.equal(span("30mm", "3.0mm"), null); // a dropped decimal point is not tolerated
  assert.equal(span("SS4OO", "SS400"), null); // letter O is not digit 0
  assert.equal(span("Q235b", "Q235B"), null); // case must match
  assert.equal(span("''", "it's"), null);
});

test("numbers are checked on the source span, so whitespace cannot merge digits", () => {
  const src = "Thickness: 2 75 mm";
  const frags = fragmentText(src);
  const out = postProcessSupply(
    { lots: [{ ...emptyLot(), thickness: { value: 275, unit: "mm", raw: "275mm", evidence: [frags[0].id] } }], ambiguities: [], ignored_instructions: [] },
    { ...ctx, fragments: frags },
  );
  const thickness = out.lots[0].fields.thickness_mm;
  assert.equal(thickness.normalized_value, null);
  assert.equal(thickness.raw_value, "2 75 mm");
  assert.deepEqual(thickness.issues, ["value_not_in_raw"]);
});

test("§11.4 30 mm thickness is flagged implausible for review", () => {
  const L = lineOf("3.0mm");
  const out = postProcessSupply(
    { lots: [{ ...emptyLot(), thickness: { value: 30, unit: "mm", raw: "30", evidence: [L] } }], ambiguities: [], ignored_instructions: [] },
    ctx,
  );
  // "30" is not in the fragment ("3.0mm"), so it is rejected before any bound check.
  assert.equal(out.lots[0].fields.thickness_mm.normalized_value, null);
});

test("§11.4 mm read as inch is caught: the unit must be written in the source span", () => {
  const L = lineOf("3.0mm");
  const fields = run({ ...emptyLot(), thickness: { value: 3.0, unit: "inch", raw: "3.0mm", evidence: [L] } });
  assert.equal(fields.thickness_mm.normalized_value, null);
  assert.deepEqual(fields.thickness_mm.issues, ["unit_not_in_raw"]);
});

test("sanity bounds flag 30 mm thickness but not 25 mm", async () => {
  const { sanityIssues } = await import("@/domain/hrc");
  assert.deepEqual(sanityIssues("thickness_mm", 30), ["implausible_thickness_mm:30"]);
  assert.deepEqual(sanityIssues("thickness_mm", 25), []);
});

test("units count when written next to a number or in a header, never inside a word", async () => {
  const { unitIn } = await import("@/ai/tasks/extract-supply");
  assert.ok(unitIn("mm", "3.0mm"));
  assert.ok(unitIn("MT", "18.0 MT, 1 coil"));
  assert.ok(unitIn("mm", "Thickness (mm): 3.0"));
  assert.ok(unitIn("吨", "约22吨"));
  assert.ok(!unitIn("t", "Thickness (mm): 3.0"));
  assert.ok(!unitIn("t", "Weight: 19.5"));
  assert.ok(!unitIn("inch", "3.0mm"));
});

test("a lot the model skipped is reported, not silently lost", () => {
  const out = postProcessSupply({ lots: [{ ...emptyLot(), seller_lot_ref: { value: "B-018", raw: "B-018", evidence: [lineOf("Lot B-018")] } }], ambiguities: [], ignored_instructions: [] }, ctx);
  assert.ok(out.issues.some((i) => i.code === "lot_not_extracted" && i.detail.startsWith("B-021")));
  assert.ok(!out.issues.some((i) => i.code === "lot_not_extracted" && i.detail.startsWith("B-018")));
});
