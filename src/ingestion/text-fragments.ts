import { createHash } from "node:crypto";

// Splits pasted text / message bodies into line fragments with stable IDs and
// character offsets into the original string, so every extracted value can
// be traced back to an exact span (plan P0-03).

export interface CellSpan {
  sheet: string;
  row: number; // 1-based sheet row
  cell: string; // A1 reference
  start: number; // offset of the cell value inside the fragment text
  end: number;
}

export interface TextFragment {
  id: string; // "L<line>" for text, "<sheet>!R<row>" for tables, "P<page>L<line>" for PDFs
  text: string;
  start: number; // inclusive offset in the original text (text) or page text (PDF)
  end: number; // exclusive offset
  cells?: CellSpan[]; // tabular rows: where each cell value sits inside `text`
  page?: number; // PDF page, 1-based
}

export function fragmentText(text: string): TextFragment[] {
  const fragments: TextFragment[] = [];
  let offset = 0;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const content = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (content.trim() !== "") {
      fragments.push({ id: `L${i + 1}`, text: content, start: offset, end: offset + content.length });
    }
    offset += line.length + 1;
  });
  return fragments;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
