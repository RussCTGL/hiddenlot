/**
 * Renders the binary demo documents (XLSX, PDF) from canonical.json, so the
 * files and the truth cannot drift apart. Text and CSV are hand-written.
 *
 *   npm run data:render
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { DEMO_DIR, loadCanonical } from "@/seed/canonical";

async function main() {
  const canonical = loadCanonical();
  for (const doc of canonical.documents) {
    const out = path.join(DEMO_DIR, doc.file);
    if (doc.kind === "xlsx") {
      const wb = new ExcelJS.Workbook();
      wb.creator = "HiddenLot synthetic data";
      wb.created = new Date("2026-10-26T00:00:00Z");
      wb.modified = wb.created;
      const ws = wb.addWorksheet(doc.sheet ?? "Stock");
      for (const row of doc.rows ?? []) ws.addRow(row);
      writeFileSync(out, new Uint8Array(await wb.xlsx.writeBuffer()));
    } else if (doc.kind === "pdf") {
      const pdf = await PDFDocument.create({ updateMetadata: false });
      pdf.setTitle("SYNTHETIC DEMO DATA");
      pdf.setCreationDate(new Date("2026-10-26T00:00:00Z"));
      pdf.setModificationDate(new Date("2026-10-26T00:00:00Z"));
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const page = pdf.addPage([595, 842]);
      (doc.lines ?? []).forEach((line, i) => page.drawText(line, { x: 56, y: 780 - i * 20, size: 11, font }));
      writeFileSync(out, await pdf.save());
    } else continue;
    console.log(`wrote ${path.relative(process.cwd(), out)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
