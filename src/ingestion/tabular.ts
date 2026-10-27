import { inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import type { CellSpan, TextFragment } from "./text-fragments";

// CSV and XLSX → row fragments (plan P0-01, P0-03).
//
// Each data row becomes one fragment whose text reads "Header: value | ...",
// so the model sees labelled values and every quoted value maps back to one
// sheet cell. Workbooks are read as data only: formulas contribute their
// cached result, and macros, external links and scripts are never executed.

export const TABULAR_PARSER_VERSION = "tabular.v2";
export const MAX_ROWS = 100; // plan §8.4 single-file limit across all sheets, stated in the UI
export const MAX_COLUMNS = 60;
// A 100-row, 60-column sheet is well under 1 MB of XML; the parser needs
// roughly 40× that in memory, so the inflated budget stays small.
export const MAX_UNZIPPED_BYTES = 4 * 1024 * 1024;
const MAX_XML_ROWS = 400; // <row> elements across visible and hidden sheets, before parsing

export class TabularError extends Error {}

export type Grid = { sheet: string; rows: { row: number; cells: { col: number; text: string }[] }[] };

const colName = (col: number) => {
  let s = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (quoted) throw new TabularError("CSV has an unterminated quoted field");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Line breaks inside a cell are flattened so a cell can never start a new
// fragment line in the prompt.
const cellText = (t: string) => t.replace(/[\r\n]+/g, " ").trim();

export function csvToGrid(text: string, sheet = "csv"): Grid {
  const rows = parseCsv(text);
  if (rows.some((r) => r.length > MAX_COLUMNS)) throw new TabularError(`A row has more than ${MAX_COLUMNS} columns`);
  return {
    sheet,
    rows: rows.map((cells, i) => ({
      row: i + 1,
      cells: cells.map((t, c) => ({ col: c + 1, text: cellText(t) })).filter((c) => c.text !== ""),
    })),
  };
}

/**
 * Inflates every zip entry under a hard output budget before the workbook
 * parser sees the file. Declared sizes in the zip are not trusted: a forged
 * header cannot get past the real byte count. Returns the total inflated size.
 */
export function checkZipExpansion(buf: Uint8Array, budget = MAX_UNZIPPED_BYTES): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new TabularError("Not a readable .xlsx workbook (no zip directory)");
  const entries = view.getUint16(eocd + 10, true);
  if (entries > 2000) throw new TabularError("Workbook has too many parts");
  let p = view.getUint32(eocd + 16, true);
  let total = 0;
  let xmlRows = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || view.getUint32(p, true) !== 0x02014b50) throw new TabularError("Not a readable .xlsx workbook (bad zip directory)");
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const local = view.getUint32(p + 42, true);
    if (compressed === 0xffffffff || local === 0xffffffff) throw new TabularError("Zip64 workbooks are not supported");
    if (local + 30 > buf.length || view.getUint32(local, true) !== 0x04034b50) throw new TabularError("Not a readable .xlsx workbook (bad entry)");
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (dataStart + compressed > buf.length) throw new TabularError("Not a readable .xlsx workbook (truncated entry)");
    const data = buf.subarray(dataStart, dataStart + compressed);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + view.getUint16(p + 28, true)));
    let inflated: Uint8Array;
    if (method === 0) inflated = data;
    else if (method === 8) {
      try {
        inflated = inflateRawSync(data, { maxOutputLength: Math.max(1, budget - total) });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new TabularError(`Workbook expands to more than ${budget / 1024 / 1024} MB; refused`);
        throw new TabularError("Not a readable .xlsx workbook (corrupt entry)");
      }
    } else throw new TabularError(`Unsupported zip compression method ${method}`);
    total += inflated.length;
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) {
      xmlRows += (new TextDecoder().decode(inflated).match(/<row[\s>]/g) ?? []).length;
      if (xmlRows > MAX_XML_ROWS) throw new TabularError(`Workbook has more than ${MAX_XML_ROWS} rows; the limit is ${MAX_ROWS} data rows`);
    }
    if (total > budget) throw new TabularError(`Workbook expands to more than ${budget / 1024 / 1024} MB; refused`);
    p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return total;
}

export async function xlsxToGrids(buffer: Uint8Array): Promise<{ grids: Grid[]; skipped: string[] }> {
  checkZipExpansion(buffer);
  const wb = new ExcelJS.Workbook();
  try {
    // exceljs reads cell values and cached formula results; it does not run macros.
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (err) {
    throw new TabularError(`Not a readable .xlsx workbook (${(err as Error).message})`);
  }
  const grids: Grid[] = [];
  const skipped: string[] = [];
  for (const ws of wb.worksheets) {
    // Hidden sheets, rows and columns are not imported, and the user is told.
    if (ws.state !== "visible") {
      skipped.push(`sheet "${ws.name}"`);
      continue;
    }
    if (ws.columnCount > MAX_COLUMNS) throw new TabularError(`Sheet "${ws.name}" has more than ${MAX_COLUMNS} columns`);
    const rows: Grid["rows"] = [];
    let hiddenRows = 0;
    const hiddenCols = new Set<number>();
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (row.hidden) {
        hiddenRows++;
        return;
      }
      const cells: { col: number; text: string }[] = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        if (ws.getColumn(col).hidden) {
          hiddenCols.add(col);
          return;
        }
        const text = cellText((cell.text ?? "").toString());
        if (text) cells.push({ col, text });
      });
      if (cells.length) rows.push({ row: rowNumber, cells });
    });
    if (hiddenRows) skipped.push(`${hiddenRows} hidden row(s) in "${ws.name}"`);
    if (hiddenCols.size) skipped.push(`${hiddenCols.size} hidden column(s) in "${ws.name}"`);
    grids.push({ sheet: ws.name, rows });
  }
  return { grids, skipped };
}

/** Header = first row with at least three non-numeric cells. Rows above it are kept as notes. */
export function gridToFragments(grid: Grid): TextFragment[] {
  const rows = grid.rows.filter((r) => r.cells.length > 0);
  const headerIdx = rows.findIndex((r) => r.cells.filter((c) => !/^[\d.,\s-]+$/.test(c.text)).length >= 3);
  const header = new Map<number, string>(headerIdx >= 0 ? rows[headerIdx].cells.map((c) => [c.col, c.text]) : []);
  const dataRows = rows.filter((_, i) => i !== headerIdx);

  const fragments: TextFragment[] = [];
  for (const r of dataRows) {
    let text = "";
    const cells: CellSpan[] = [];
    for (const c of r.cells) {
      if (text) text += " | ";
      const label = header.get(c.col);
      if (label && r.row > rows[headerIdx].row) text += `${label}: `;
      const start = text.length;
      text += c.text;
      cells.push({ sheet: grid.sheet, row: r.row, cell: `${colName(c.col)}${r.row}`, start, end: text.length });
    }
    fragments.push({ id: `${grid.sheet}!R${r.row}`, text, start: 0, end: text.length, cells });
  }
  return fragments;
}
