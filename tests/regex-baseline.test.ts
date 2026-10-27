import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { postProcessSupply } from "@/ai/tasks/extract-supply";
import { regexExtract } from "@/ingestion/regex-baseline";
import { csvToGrid, gridToFragments } from "@/ingestion/tabular";
import { fragmentText } from "@/ingestion/text-fragments";

const ctx = (fragments: ReturnType<typeof fragmentText>) => ({
  fragments,
  sourceId: "synthetic:test",
  ownerNetworkId: "net-b",
  synthetic: true,
  extractionRunId: null,
  observedAt: "2026-10-26T00:00:00.000Z",
});

test("baseline on the probe message: finds both lots, keeps unit-less and 'ton' values Unknown", () => {
  const text = readFileSync(path.join(__dirname, "../data/synthetic/probe/stock-network-b.txt"), "utf8");
  const frags = fragmentText(text);
  const { lots } = postProcessSupply(regexExtract(frags), ctx(frags));
  assert.equal(lots.length, 2);
  const [b018, b021] = lots;
  assert.equal(b018.fields.seller_lot_ref.normalized_value, "B-018");
  assert.equal(b018.fields.grade_raw.normalized_value, "SS400");
  assert.equal(b018.fields.thickness_mm.normalized_value, 3);
  assert.equal(b018.fields.total_kg.normalized_value, 18000);
  assert.equal(b018.fields.product_form.normalized_value, "hot_rolled_coil");
  assert.equal(b021.fields.grade_raw.normalized_value, "Q235B");
  assert.equal(b021.fields.thickness_mm.normalized_value, null); // "2.75*1250*C" has no unit
  assert.equal(b021.fields.total_kg.normalized_value, null); // "22 ton" is ambiguous
  assert.deepEqual(b021.fields.total_kg.issues, ["ambiguous_ton"]);
});

test("baseline on a table maps headers to fields with cell locators", () => {
  const frags = gridToFragments(csvToGrid("Lot,Grade,Standard,Thickness (mm),Width (mm),Weight (MT)\nC-101,SS400,KS D3503,3.0,1500,19.5\n", "stock"));
  const { lots } = postProcessSupply(regexExtract(frags), ctx(frags));
  assert.equal(lots.length, 1);
  const f = lots[0].fields;
  assert.equal(f.seller_lot_ref.normalized_value, "C-101");
  assert.equal(f.thickness_mm.normalized_value, 3);
  assert.equal(f.total_kg.normalized_value, 19500);
  assert.deepEqual(f.total_kg.evidence[0].locator, { kind: "sheet_cell", sheet: "stock", row: 2, cell: "F2" });
});
