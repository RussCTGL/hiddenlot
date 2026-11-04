// A one-page text PDF with no dependencies, for the synthetic demo documents
// and the proforma the app builds from an order. Helvetica, ASCII only; every
// page carries the synthetic-document footer.

export const SYNTHETIC_FOOTER = "SYNTHETIC DEMO DOCUMENT - fictional companies and figures, not a real trade.";

/** A one-page PDF with a title and a few lines, stamped as a synthetic demo document. */
export function tinyPdf(title: string, lines: string[]): Uint8Array {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`).replace(/×/g, "x").replace(/[^\x20-\x7e]/g, "?");
  const step = lines.length > 24 ? 16 : 20;
  const text = [
    `BT /F1 16 Tf 56 770 Td (${esc(title)}) Tj ET`,
    ...lines.slice(0, 40).map((l, i) => `BT /F1 11 Tf 56 ${730 - i * step} Td (${esc(l)}) Tj ET`),
    `BT /F1 9 Tf 56 60 Td (${SYNTHETIC_FOOTER}) Tj ET`,
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
