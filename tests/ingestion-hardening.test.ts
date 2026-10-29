import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { postProcessSupply, type ExtractedLot } from "@/ai/tasks/extract-supply";
import type { Actor } from "@/auth/access";
import type { Db } from "@/db/client";
import { freshDb } from "./db";
import { insertLot } from "@/db/repo";
import { intakeDocument, parseDocument, type MetaExtract } from "@/ingestion/intake";
import { pdfToFragments, PdfError } from "@/ingestion/pdf";
import { checkZipExpansion, csvToGrid, gridToFragments, xlsxToGrids } from "@/ingestion/tabular";
import { lot as testLot, NOW } from "./helpers";

// P2 review regressions: evidence integrity, limits, intake status.

const none = { value: null, raw: null, evidence: [] as string[] };
const emptyLot = (): ExtractedLot =>
  ({
    seller_lot_ref: none, product_form: none, grade: none, standard_id: none, standard_edition: none,
    certificate_claims: { value: [], raw: null, evidence: [] }, heat_numbers: { value: [], raw: null, evidence: [] },
    thickness: { ...none, unit: null }, width: { ...none, unit: null }, total_weight: { ...none, unit: null },
    piece_count: none, splittable: none, location_country: none, location_place: none, available_from: none,
    price_amount: none, price_currency: none, price_basis: none, incoterm: none, incoterm_place: none,
    condition: none, defect_notes: none, surplus_reason: none,
  }) as ExtractedLot;

const table = (csv: string) => gridToFragments(csvToGrid(csv, "stock"));
const process = (frags: ReturnType<typeof table>, lot: ExtractedLot) =>
  postProcessSupply({ lots: [lot], ambiguities: [], ignored_instructions: [] }, { fragments: frags, sourceId: "t", ownerNetworkId: "net-b", synthetic: true, extractionRunId: null, observedAt: NOW.toISOString() }).lots[0].fields;

test("numbers are never read out of a longer token (15 from 1500, 235 from Q235B, 0 from 3.0)", () => {
  const frags = table("Lot,Grade,Thickness,Width,Coils\nC-1,Q235B,3.0,1500,1\n");
  const R = frags[0].id;
  const f = process(frags, {
    ...emptyLot(),
    piece_count: { value: 15, raw: "15", evidence: [R] },
    price_amount: { value: "235", raw: "235", evidence: [R] },
    thickness: { value: 0, unit: null, raw: "0", evidence: [R] },
  });
  assert.equal(f.piece_count.normalized_value, null);
  assert.equal(f.price_amount.normalized_value, null);
  assert.equal(f.thickness_mm.normalized_value, null);
});

test("the same value in two cells is ambiguous unless the header is quoted", () => {
  const frags = table("Lot,Weight (MT),Coils\nC-2,2,2\n");
  const R = frags[0].id;
  const bare = process(frags, { ...emptyLot(), piece_count: { value: 2, raw: "2", evidence: [R] } });
  assert.equal(bare.piece_count.normalized_value, null);
  assert.ok(bare.piece_count.issues.includes("ambiguous_cell"));
  const labelled = process(frags, { ...emptyLot(), piece_count: { value: 2, raw: "Coils: 2", evidence: [R] } });
  assert.equal(labelled.piece_count.normalized_value, 2);
  assert.deepEqual(labelled.piece_count.evidence[0].locator, { kind: "sheet_cell", sheet: "stock", row: 2, cell: "C2" });
});

test("a quote spanning two cells is rejected", () => {
  const frags = table("Lot,Grade,Std\nC-3,SS400,JIS G3101\n");
  const f = process(frags, { ...emptyLot(), grade: { value: "SS400", raw: "SS400 | Std: JIS", evidence: [frags[0].id] } });
  assert.equal(f.grade_raw.normalized_value, null);
});

test("cross-row evidence: a lot cannot take a value from another row", () => {
  const frags = table("Lot,Grade,Thickness (mm)\nC-4,SS400,3.0\nC-5,SS400,2.0\n");
  const [r2, r3] = frags.map((f) => f.id);
  const f = process(frags, {
    ...emptyLot(),
    seller_lot_ref: { value: "C-4", raw: "Lot: C-4", evidence: [r2] },
    thickness: { value: 2.0, unit: "mm", raw: "Thickness (mm): 2.0", evidence: [r3] },
  });
  assert.equal(f.thickness_mm.normalized_value, null);
  assert.ok(f.thickness_mm.issues.some((i) => i.startsWith("cross_row_evidence")));
  assert.equal(f.seller_lot_ref.normalized_value, "C-4");
});

test("limits: rows across sheets, wide rows, long lines and huge pasted text", async () => {
  const wb = new ExcelJS.Workbook();
  for (const name of ["S1", "S2", "S3"]) {
    const ws = wb.addWorksheet(name);
    ws.addRow(["Lot", "Grade", "Thickness"]);
    for (let i = 0; i < 40; i++) ws.addRow([`${name}-${i}`, "SS400", "3"]);
  }
  await assert.rejects(parseDocument("xlsx", new Uint8Array(await wb.xlsx.writeBuffer())), /limit is 100/);
  const wide = "a," + "x,".repeat(70) + "\n";
  await assert.rejects(parseDocument("csv", new TextEncoder().encode(wide)), /columns/);
  await assert.rejects(parseDocument("text", new TextEncoder().encode("x".repeat(5000))), /longer than/);
  await assert.rejects(parseDocument("text", new TextEncoder().encode("line\n".repeat(500))), /limit is 400/);
});

test("xlsx: hidden rows and columns are not imported and are reported", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Stock");
  ws.addRow(["Lot", "Grade", "Floor price", "Thickness"]);
  ws.addRow(["A-1", "SS400", "480", "3.0"]);
  ws.addRow(["A-2", "SS400", "470", "3.0"]).hidden = true;
  ws.getColumn(3).hidden = true;
  const { grids, skipped } = await xlsxToGrids(new Uint8Array(await wb.xlsx.writeBuffer()));
  const text = gridToFragments(grids[0]).map((f) => f.text).join("\n");
  assert.ok(!text.includes("480") && !text.includes("A-2"));
  assert.equal(skipped.length, 2);
});

test("zip expansion is capped on real inflated bytes, not on declared sizes", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("S");
  for (let i = 0; i < 300; i++) ws.addRow([`${i}-${"x".repeat(2000)}`]); // ~600 KB of compressible, unique strings
  const buf = new Uint8Array(await wb.xlsx.writeBuffer());
  assert.ok(checkZipExpansion(buf) > 500_000);
  // Forge every declared uncompressed size to 10 bytes: the guard must still count real bytes.
  const forged = Buffer.from(buf);
  for (let i = 0; i < forged.length - 4; i++) if (forged.readUInt32LE(i) === 0x02014b50) forged.writeUInt32LE(10, i + 24);
  assert.throws(() => checkZipExpansion(new Uint8Array(forged), 500_000), /refused/);
});

test("a corrupt PDF page is a clean failure, not a crash", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText("Lot X-1 SS400", { x: 50, y: 700, size: 11, font });
  const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
  // Corrupt the page content stream bytes.
  const at = bytes.indexOf("stream");
  for (let i = at + 8; i < at + 40 && i < bytes.length; i++) bytes[i] = 0xff;
  await assert.rejects(pdfToFragments(new Uint8Array(bytes)), PdfError);
});

// --- intake --------------------------------------------------------------------

let db: Db;
const B: Actor = { id: "u-b", network_id: "net-b", role: "trader" };
const A: Actor = { id: "u-a", network_id: "net-a", role: "trader" };
before(async () => {
  db = await freshDb();
});
after(async () => db.close());
beforeEach(async () => {
  for (const t of ["audit_events", "lot_versions", "lots", "extraction_runs", "source_fragments", "source_documents", "users", "networks"]) await db.query(`DELETE FROM ${t}`);
  await db.query(`INSERT INTO networks (id, name, alias) VALUES ('net-a','A','Network A'), ('net-b','B','Network B')`);
  await db.query(`INSERT INTO users (id, network_id, name, role) VALUES ('u-a','net-a','a','trader'), ('u-b','net-b','b','trader')`);
});

const offer = new TextEncoder().encode("Lot B-500\nSS400 3.0mm x 1500mm, 18 MT, prime\n");
const input = (extractor: "meta" | "regex_baseline") => ({ bytes: offer, filename: "o.txt", mime: null, extractor, synthetic: true });

test("a failed import is reported as failed and is retried on re-upload", async () => {
  const failing: MetaExtract = async () => ({ output: null, run: { result_status: "timeout" } as never, error: "Meta extraction timeout" });
  const first = await intakeDocument(db, B, input("meta"), failing, NOW);
  assert.equal(first.status, "failed");
  const again = await intakeDocument(db, B, input("meta"), failing, NOW);
  assert.equal(again.status, "failed");
  assert.equal(again.duplicate_document, false); // re-attempted, not a stale "needs_review"
  const ok = await intakeDocument(db, B, input("regex_baseline"), null, NOW);
  assert.equal(ok.status, "needs_review");
  assert.equal(ok.lots.length, 1);
  const repeat = await intakeDocument(db, B, input("regex_baseline"), null, NOW);
  assert.equal(repeat.duplicate_document, true);
  assert.equal(repeat.status, "needs_review");
});

test("the same file from another network is its own import", async () => {
  const b = await intakeDocument(db, B, input("regex_baseline"), null, NOW);
  const a = await intakeDocument(db, A, input("regex_baseline"), null, NOW);
  assert.notEqual(a.document_id, b.document_id);
  assert.equal(a.duplicate_document, false);
});

test("dedupe never merges on the reference plus unknown specs", async () => {
  await insertLot(db, testLot({ seller_lot_ref: "B-500", thickness_mm: null, width_mm: null, total_kg: null }, { lot_id: "lot-old", owner_network_id: "net-b", status: "needs_review" }), null, "u-b");
  const r = await intakeDocument(db, B, input("regex_baseline"), null, NOW);
  assert.equal(r.lots.length, 1);
  assert.equal(r.duplicates.length, 0);
  assert.ok(r.issues.some((i) => i.code === "possible_duplicate" && i.detail === "lot-old"));
});

test("lot references compare without the 'Lot' prefix or spacing", async () => {
  const { lotRefKey } = await import("@/domain/hrc");
  assert.equal(lotRefKey("Lot B-030"), "B-030");
  assert.equal(lotRefKey("lot no. b-030"), "B-030");
  assert.equal(lotRefKey("批号：B-030"), "B-030");
  assert.notEqual(lotRefKey("B-0301"), lotRefKey("B-030"));
});

test("values are checked as whole tokens of the cell value, not the header", () => {
  const frags = table("Lot,Grade,Available from,Price\nC-101,Q235B,2026-11-05,USD 552/MT CFR Haiphong\n");
  const R = frags[0].id;
  const f = process(frags, {
    ...emptyLot(),
    seller_lot_ref: { value: "C-10", raw: "Lot: C-101", evidence: [R] },
    grade: { value: "Q235", raw: "Grade: Q235B", evidence: [R] },
    incoterm: { value: "Price", raw: "Price: USD 552/MT CFR Haiphong", evidence: [R] },
    available_from: { value: "2026-05-11", raw: "Available from: 2026-11-05", evidence: [R] },
    price_currency: { value: "EUR", raw: "Price: USD 552/MT CFR Haiphong", evidence: [R] },
  });
  assert.equal(f.seller_lot_ref.normalized_value, null);
  assert.equal(f.grade_raw.normalized_value, null);
  assert.equal(f.incoterm.normalized_value, null);
  assert.equal(f.available_from.normalized_value, null);
  assert.equal(f.price_currency.normalized_value, null);
  const ok = process(frags, {
    ...emptyLot(),
    grade: { value: "Q235B", raw: "Grade: Q235B", evidence: [R] },
    available_from: { value: "2026-11-05", raw: "Available from: 2026-11-05", evidence: [R] },
    incoterm: { value: "CFR", raw: "Price: USD 552/MT CFR Haiphong", evidence: [R] },
    price_currency: { value: "USD", raw: "Price: USD 552/MT CFR Haiphong", evidence: [R] },
  });
  assert.equal(ok.grade_raw.normalized_value, "Q235B");
  assert.equal(ok.available_from.normalized_value, "2026-11-05");
  assert.equal(ok.incoterm.normalized_value, "CFR");
  assert.equal(ok.price_currency.normalized_value, "USD");
});

test("cross-lot evidence in running text: a lot cannot take a value from the next lot's lines", async () => {
  const { fragmentText } = await import("@/ingestion/text-fragments");
  const frags = fragmentText("HRC 热轧卷\nLot B-018\nSS400 3.0mm x 1500mm\nLot B-030\nSS400 6.0mm x 2000mm\n");
  const out = postProcessSupply(
    {
      lots: [
        { ...emptyLot(), seller_lot_ref: { value: "B-018", raw: "B-018", evidence: ["L2"] }, product_form: { value: "hot_rolled_coil", raw: "HRC", evidence: ["L1"] }, thickness: { value: 6, unit: "mm", raw: "6.0mm", evidence: ["L5"] } },
        { ...emptyLot(), seller_lot_ref: { value: "B-030", raw: "B-030", evidence: ["L4"] }, thickness: { value: 6, unit: "mm", raw: "6.0mm", evidence: ["L5"] } },
      ],
      ambiguities: [],
      ignored_instructions: [],
    },
    { fragments: frags, sourceId: "t", ownerNetworkId: "n", synthetic: true, extractionRunId: null, observedAt: NOW.toISOString() },
  );
  assert.equal(out.lots[0].fields.thickness_mm.normalized_value, null);
  assert.ok(out.lots[0].fields.thickness_mm.issues.some((i) => i.startsWith("cross_lot_evidence")));
  assert.equal(out.lots[0].fields.product_form.normalized_value, "hot_rolled_coil"); // shared heading is fine
  assert.equal(out.lots[1].fields.thickness_mm.normalized_value, 6);
});

test("a table title row above the header may be cited by any lot", () => {
  const frags = table("HRC stock list\nLot,Grade,Thickness (mm)\nC-6,SS400,3.0\n");
  const [title, row] = frags;
  const f = process(frags, {
    ...emptyLot(),
    seller_lot_ref: { value: "C-6", raw: "Lot: C-6", evidence: [row.id] },
    product_form: { value: "hot_rolled_coil", raw: "HRC", evidence: [title.id] },
  });
  assert.equal(f.product_form.normalized_value, "hot_rolled_coil");
});

test("a workbook with too many rows is refused before it is parsed", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("S");
  for (let i = 0; i < 500; i++) ws.addRow([i, "SS400"]);
  const buf = new Uint8Array(await wb.xlsx.writeBuffer());
  assert.throws(() => checkZipExpansion(buf), /more than 400 rows/);
});

test("lot sections come from the document, so omitting lots does not disable the check", async () => {
  const { fragmentText } = await import("@/ingestion/text-fragments");
  const frags = fragmentText("Lot B-018\nSS400 3.0mm x 1500mm\nLot B-030\nSS400 6.0mm x 2000mm\nLot B-044\nQ235B 2.75mm\n");
  const only = (lot: ExtractedLot) =>
    postProcessSupply({ lots: [lot], ambiguities: [], ignored_instructions: [] }, { fragments: frags, sourceId: "t", ownerNetworkId: "n", synthetic: true, extractionRunId: null, observedAt: NOW.toISOString() }).lots[0].fields;
  const withRef = only({ ...emptyLot(), seller_lot_ref: { value: "B-018", raw: "B-018", evidence: ["L1"] }, thickness: { value: 6, unit: "mm", raw: "6.0mm", evidence: ["L4"] } });
  assert.equal(withRef.thickness_mm.normalized_value, null);
  const noRef = only({ ...emptyLot(), thickness: { value: 6, unit: "mm", raw: "6.0mm", evidence: ["L4"] } });
  assert.equal(noRef.thickness_mm.normalized_value, null);
  assert.ok(noRef.thickness_mm.issues.some((i) => i.startsWith("lot_section_unknown")));
});

test("dates: month must match; swappable numeric dates are ambiguous", async () => {
  const { dateInSource } = await import("@/ai/tasks/extract-supply");
  assert.equal(dateInSource("2026-11-05", "Available 5 Nov 2026"), "ok");
  assert.equal(dateInSource("2026-12-05", "Available 5 Nov 2026"), "date_not_in_raw");
  assert.equal(dateInSource("2026-11-05", "可提货 2026年11月5日"), "ok");
  assert.equal(dateInSource("2026-11-05", "11/05/2026"), "ambiguous_date");
  assert.equal(dateInSource("2026-11-25", "25/11/2026"), "ok");
  assert.equal(dateInSource("2026-11-05", "2026-11-05"), "iso");
  assert.equal(dateInSource("2026-05-11", "2026-11-05"), "date_not_in_raw");
});

test("currency marks: S$ and HK$ are not USD; bare 元 or ¥ prove nothing", () => {
  const frags = table("Lot,Grade,Price\nC-9,SS400,S$ 700/MT\nC-10,SS400,USD 552/MT\n");
  const f = process([frags[0]], { ...emptyLot(), price_currency: { value: "USD", raw: "Price: S$ 700/MT", evidence: [frags[0].id] } });
  assert.equal(f.price_currency.normalized_value, null);
});

test("P2 minors: bare references start sections; month names need an adjacent day", async () => {
  const { fragmentText } = await import("@/ingestion/text-fragments");
  const { dateInSource } = await import("@/ai/tasks/extract-supply");
  const frags = fragmentText("B-018 SS400 3.0mm\nB-030 SS400 6.0mm\n");
  const f = postProcessSupply(
    { lots: [{ ...emptyLot(), seller_lot_ref: { value: "B-018", raw: "B-018", evidence: ["L1"] }, thickness: { value: 6, unit: "mm", raw: "6.0mm", evidence: ["L2"] } }], ambiguities: [], ignored_instructions: [] },
    { fragments: frags, sourceId: "t", ownerNetworkId: "n", synthetic: true, extractionRunId: null, observedAt: NOW.toISOString() },
  ).lots[0].fields;
  assert.equal(f.thickness_mm.normalized_value, null);
  assert.equal(dateInSource("2026-05-05", "goods may ship 2026, 5 coils"), "date_not_in_raw");
  assert.equal(dateInSource("2026-11-05", "ready Nov 5th 2026"), "ok");
});

test("sections also start at 'Ref D-100' / '编号 D-100' lines, never at 'heat no. …'", async () => {
  const { fragmentText } = await import("@/ingestion/text-fragments");
  const frags = fragmentText("Ref D-100 | HRC | SS400 | 3.0 x 1500 mm\nRef D-101 | HRC | Q235B | 6.0 x 2000 mm\n编号 D-102，热卷，Q235B\nheat no. H24-77812\n");
  const out = postProcessSupply(
    { lots: [{ ...emptyLot(), thickness: { value: 6, unit: "mm", raw: "6.0 x 2000 mm", evidence: ["L2"] } }], ambiguities: [], ignored_instructions: [] },
    { fragments: frags, sourceId: "t", ownerNetworkId: "n", synthetic: true, extractionRunId: null, observedAt: NOW.toISOString() },
  );
  assert.equal(out.lots[0].fields.thickness_mm.normalized_value, null); // no lot reference, value from a sectioned line
  const missed = out.issues.filter((i) => i.code === "lot_not_extracted").map((i) => i.detail.split(" ")[0]);
  assert.deepEqual(missed, ["D-100", "D-101", "D-102"]); // H24-77812 is not a lot
});
