import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { toStrictJsonSchema } from "@/ai/json-schema";
import { numbersIn, postProcessSupply, SupplyExtraction, type ExtractedLot } from "@/ai/tasks/extract-supply";
import { fragmentText } from "@/ingestion/text-fragments";

const text = readFileSync(path.join(__dirname, "../data/synthetic/probe/stock-network-b.txt"), "utf8");
const fragments = fragmentText(text);
const lineOf = (needle: string) => fragments.find((f) => f.text.includes(needle))!.id;

const none = { value: null, raw: null, evidence: [] };
const emptyLot = (): ExtractedLot => ({
  seller_lot_ref: none,
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

function run(lot: ExtractedLot) {
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
