import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { locatorFor } from "@/ai/tasks/extract-supply";
import { pdfToFragments, PdfError } from "@/ingestion/pdf";
import { parseDocument } from "@/ingestion/intake";
import { csvToGrid, gridToFragments, parseCsv, TabularError, xlsxToGrids } from "@/ingestion/tabular";

test("CSV parser handles quotes, embedded commas, doubled quotes and CRLF", () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n'), [
    ["a", "b, c", 'say "hi"'],
    ["1", "2", "3"],
  ]);
  assert.throws(() => parseCsv('a,"open'), TabularError);
});

test("table rows become labelled fragments whose spans map back to one cell", () => {
  const grid = csvToGrid("SYNTHETIC — not a real offer\nLot,Grade,Thickness,Width\nC-101,SS400,3.0 mm,1500\n", "stock");
  const frags = gridToFragments(grid);
  assert.equal(frags[0].text, "SYNTHETIC — not a real offer"); // note row above the header
  const row = frags.find((f) => f.id === "stock!R3")!;
  assert.equal(row.text, "Lot: C-101 | Grade: SS400 | Thickness: 3.0 mm | Width: 1500");
  const at = row.text.indexOf("3.0 mm");
  assert.deepEqual(locatorFor(row, [at, at + 6]), { kind: "sheet_cell", sheet: "stock", row: 3, cell: "C3" });
  // A quote spanning "Grade: SS400" lands on the value cell, not the header.
  const g = row.text.indexOf("Grade: SS400");
  assert.deepEqual(locatorFor(row, [g, g + 12]), { kind: "sheet_cell", sheet: "stock", row: 3, cell: "B3" });
});

test("row limit is enforced with a clear reason", async () => {
  const csv = ["Lot,Grade,Thickness"].concat(Array.from({ length: 101 }, (_, i) => `L${i},SS400,3`)).join("\n");
  await assert.rejects(parseDocument("csv", new TextEncoder().encode(csv)), /limit is 100/);
});

test("XLSX: formulas contribute cached values, hidden sheets are skipped", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Stock");
  ws.addRow(["Lot", "Grade", "Weight (MT)", "Width"]);
  ws.addRow(["A-007", "SS400", { formula: "10+9.5", result: 19.5 }, 1219]);
  const hidden = wb.addWorksheet("Internal");
  hidden.state = "hidden";
  hidden.addRow(["secret", "floor price", "480", "x"]);
  const buf = new Uint8Array(await wb.xlsx.writeBuffer());
  const { grids, skipped } = await xlsxToGrids(buf);
  assert.deepEqual(grids.map((g) => g.sheet), ["Stock"]);
  assert.deepEqual(skipped, ['sheet "Internal"']);
  const [row] = gridToFragments(grids[0]);
  assert.equal(row.text, "Lot: A-007 | Grade: SS400 | Weight (MT): 19.5 | Width: 1219");
  await assert.rejects(xlsxToGrids(new TextEncoder().encode("not a zip")), TabularError);
});

test("text PDF: lines become page-located fragments; scans are rejected", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  ["SYNTHETIC DEMO DATA", "Lot C-101  Grade: SS400  Standard: KS D3503", "Size: 3.0 mm x 1500 mm   Weight: 19.5 MT"].forEach((t, i) =>
    page.drawText(t, { x: 50, y: 780 - i * 18, size: 11, font }),
  );
  const { fragments } = await pdfToFragments(await doc.save());
  assert.equal(fragments.length, 3);
  const size = fragments.find((f) => f.text.includes("3.0 mm"))!;
  assert.equal(size.id, "P1L3");
  const at = size.text.indexOf("3.0 mm");
  const loc = locatorFor(size, [at, at + 6]);
  assert.equal(loc.kind, "pdf_text");

  const blank = await PDFDocument.create();
  blank.addPage([595, 842]);
  await assert.rejects(pdfToFragments(await blank.save()), PdfError);
  await assert.rejects(pdfToFragments(new TextEncoder().encode("%PDF-garbage")), PdfError);
});
