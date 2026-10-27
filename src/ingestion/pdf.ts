import type { TextFragment } from "./text-fragments";

// Text PDFs → line fragments with page locators (plan P0-01, P0-03).
// Only the embedded text layer is read: no OCR, no scripts, no form actions,
// no external resources. A PDF without a text layer is rejected with a clear
// reason instead of being guessed at.

export const PDF_PARSER_VERSION = "pdf.v2";
export const MAX_PAGES = 20;
export const MAX_ITEMS_PER_PAGE = 5000;

export class PdfError extends Error {}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  hasEOL?: boolean;
}

export async function pdfToFragments(data: Uint8Array): Promise<{ fragments: TextFragment[]; pages: string[] }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > MAX_PAGES) throw new PdfError(`PDF has ${doc.numPages} pages; the limit is ${MAX_PAGES}`);
    const fragments: TextFragment[] = [];
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      if (content.items.length > MAX_ITEMS_PER_PAGE) throw new PdfError(`Page ${p} has more than ${MAX_ITEMS_PER_PAGE} text items`);
      const lines = groupLines(content.items.filter((i) => "str" in i) as TextItem[]);
      let offset = 0;
      let pageText = "";
      lines.forEach((line, i) => {
        if (line.trim()) fragments.push({ id: `P${p}L${i + 1}`, text: line, start: offset, end: offset + line.length, page: p });
        pageText += line + "\n";
        offset += line.length + 1;
      });
      pages.push(pageText);
    }
    if (fragments.length === 0) throw new PdfError("PDF has no text layer (scanned documents are not supported)");
    return { fragments, pages };
  } catch (err) {
    if (err instanceof PdfError) throw err;
    // Any parser failure (corrupt stream, bad xref, password) is a clean, reported failure.
    throw new PdfError(`Not a readable PDF (${(err as Error).message})`);
  } finally {
    await task.destroy();
  }
}

/** Groups positioned text items into lines by baseline, left to right. O(n log n). */
function groupLines(items: TextItem[]): string[] {
  const sorted = items.filter((it) => it.str).sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  const rows: TextItem[][] = [];
  let rowY = Number.NaN;
  for (const it of sorted) {
    const y = it.transform[5];
    if (rows.length && Math.abs(rowY - y) < 2) rows[rows.length - 1].push(it);
    else {
      rows.push([it]);
      rowY = y;
    }
  }
  return rows.map((r) => {
    r.sort((a, b) => a.transform[4] - b.transform[4]);
    let line = "";
    let lastEnd: number | null = null;
    for (const it of r) {
      const x = it.transform[4];
      if (lastEnd !== null && x - lastEnd > 1.5 && !line.endsWith(" ") && !it.str.startsWith(" ")) line += " ";
      line += it.str;
      lastEnd = x + it.width;
    }
    return line.replace(/[\r\n]+/g, " ").replace(/\s+$/, "");
  });
}
