import { createHash } from "node:crypto";
import type { ModelRunRecord } from "@/ai/meta/client";
import { postProcessSupply, type ExtractionIssue, type SupplyExtraction } from "@/ai/tasks/extract-supply";
import type { Actor } from "@/auth/access";
import type { Db, Sql } from "@/db/client";
import { audit, insertLot, newId } from "@/db/repo";
import { lotRefKey, type InventoryLot } from "@/domain/hrc";
import { pdfToFragments, PDF_PARSER_VERSION, PdfError } from "./pdf";
import { REGEX_BASELINE_VERSION, regexExtract } from "./regex-baseline";
import { csvToGrid, gridToFragments, MAX_ROWS, TABULAR_PARSER_VERSION, TabularError, xlsxToGrids } from "./tabular";
import { fragmentText, type TextFragment } from "./text-fragments";

// Intake pipeline (plan §8.4): uploaded → parsed → extracted → needs_review.
// Lots created here are drafts. Nothing is visible to other networks until
// the owner reviews and publishes, and only under the owner's grants.

// Vercel refuses request bodies over 4.5 MB before they reach the app.
export const MAX_BYTES = (process.env.VERCEL ? 4 : 10) * 1024 * 1024;
export const TEXT_PARSER_VERSION = "text.v1";

export type DocKind = "text" | "csv" | "xlsx" | "pdf";
// canonical_seed: hand-written truth for the synthetic demo, run through the same post-checks.
export type ExtractorName = "meta" | "regex_baseline" | "canonical_seed";

export interface ExtractorResult {
  output: SupplyExtraction | null;
  run: ModelRunRecord | null; // null for the baseline
  error: string | null;
}
/** Model call is injected so the pipeline is testable without a key or network. */
export type MetaExtract = (fragments: TextFragment[], sourceId: string, sourceHash: string) => Promise<ExtractorResult>;

export class IntakeError extends Error {}

export function detectKind(filename: string | null, mime: string | null, bytes: Uint8Array): DocKind {
  const name = (filename ?? "").toLowerCase();
  if (name.endsWith(".xlsx") || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (name.endsWith(".csv") || mime === "text/csv") return "csv";
  if (name.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (name.endsWith(".xls") || name.endsWith(".xlsm") || name.endsWith(".docx")) {
    throw new IntakeError("Only .xlsx workbooks, .csv, text .pdf and pasted text are supported (macro-enabled and legacy formats are refused)");
  }
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) throw new IntakeError("Zip-based file without .xlsx name; rename it or export as .xlsx");
  return "text";
}

const parserVersion = (kind: DocKind) => (kind === "pdf" ? PDF_PARSER_VERSION : kind === "text" ? TEXT_PARSER_VERSION : TABULAR_PARSER_VERSION);

export const MAX_FRAGMENTS = 400;
export const MAX_FRAGMENT_CHARS = 4000;
export const MAX_TOTAL_CHARS = 200_000;

export interface Parsed {
  fragments: TextFragment[];
  warnings: string[];
}

/** Parses a document into fragments, enforcing the same limits for every format. */
export async function parseDocument(kind: DocKind, bytes: Uint8Array): Promise<Parsed> {
  let fragments: TextFragment[];
  const warnings: string[] = [];
  switch (kind) {
    case "text": {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (text.includes("\u0000")) throw new IntakeError("This looks like a binary file, not text");
      fragments = fragmentText(text);
      break;
    }
    case "csv":
      fragments = gridToFragments(csvToGrid(new TextDecoder().decode(bytes), "csv"));
      break;
    case "xlsx": {
      const { grids, skipped } = await xlsxToGrids(bytes);
      fragments = grids.flatMap(gridToFragments);
      if (skipped.length) warnings.push(`Not imported: ${skipped.join("; ")}`);
      break;
    }
    case "pdf":
      fragments = (await pdfToFragments(bytes)).fragments;
      break;
  }
  const tableRows = fragments.filter((f) => f.cells).length;
  if (tableRows > MAX_ROWS) throw new IntakeError(`File has ${tableRows} table rows; the limit is ${MAX_ROWS}`);
  if (fragments.length > MAX_FRAGMENTS) throw new IntakeError(`File has ${fragments.length} lines; the limit is ${MAX_FRAGMENTS}`);
  const long = fragments.find((f) => f.text.length > MAX_FRAGMENT_CHARS);
  if (long) throw new IntakeError(`Line ${long.id} is longer than ${MAX_FRAGMENT_CHARS} characters`);
  if (fragments.reduce((n, f) => n + f.text.length, 0) > MAX_TOTAL_CHARS) throw new IntakeError(`File has more than ${MAX_TOTAL_CHARS} characters of text`);
  return { fragments, warnings };
}

export interface IntakeInput {
  bytes: Uint8Array;
  filename: string | null;
  mime: string | null;
  extractor: ExtractorName;
  synthetic: boolean;
  /** Fixed lot IDs, in extraction order (seed only). */
  lot_ids?: string[];
}

export interface IntakeResult {
  document_id: string;
  duplicate_document: boolean;
  lots: string[];
  duplicates: { lot_index: number; existing_lot_id: string }[];
  issues: ExtractionIssue[];
  ignored_instructions: SupplyExtraction["ignored_instructions"];
  status: "needs_review" | "failed";
  error: string | null;
  warnings: string[];
}

export async function intakeDocument(db: Db, actor: Actor, input: IntakeInput, metaExtract: MetaExtract | null, now: Date): Promise<IntakeResult> {
  if (input.bytes.byteLength === 0) throw new IntakeError("Empty file");
  if (input.bytes.byteLength > MAX_BYTES) throw new IntakeError(`File is ${(input.bytes.byteLength / 1e6).toFixed(1)} MB; the limit is ${MAX_BYTES / 1024 / 1024} MB`);
  const kind = detectKind(input.filename, input.mime, input.bytes);
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const pv = parserVersion(kind);

  // Idempotency (plan §8.4): same file, same network, same parser → the
  // existing import, reported with its real status. A failed import is not a
  // result to keep: it is removed and the file is processed again.
  const existing = (await db.query<{ id: string; status: string; error: string | null }>(
    `SELECT id, status, error FROM source_documents WHERE network_id = $1 AND sha256 = $2 AND parser_version = $3`,
    [actor.network_id, sha, pv],
  ))[0];
  // "parsed" with no extraction means an earlier run died midway; retry it too.
  if (existing && existing.status !== "failed" && existing.status !== "parsed" && existing.status !== "uploaded") return existingResult(db, existing);
  if (existing) {
    await db.query(`DELETE FROM source_documents WHERE id = $1`, [existing.id]);
    await audit(db, actor.id, "document.retry", "document", existing.id, { previous_error: existing.error });
  }

  const docId = newId("doc");
  let parsed: Parsed = { fragments: [], warnings: [] };
  let parseError: string | null = null;
  try {
    parsed = await parseDocument(kind, input.bytes);
    if (parsed.fragments.length === 0) parseError = "No text found in the file";
  } catch (err) {
    if (err instanceof TabularError || err instanceof PdfError || err instanceof IntakeError) parseError = err.message;
    else throw err;
  }
  const fragments = parsed.fragments;
  const warnings = parsed.warnings;

  try {
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO source_documents (id, network_id, kind, filename, mime, size_bytes, sha256, parser_version, status, error, content, synthetic, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [docId, actor.network_id, kind, input.filename, input.mime, input.bytes.byteLength, sha, pv, parseError ? "failed" : "parsed", parseError, input.bytes, input.synthetic, actor.id],
      );
      await audit(tx, actor.id, "document.upload", "document", docId, { kind, bytes: input.bytes.byteLength });
      for (const [seq, f] of fragments.entries()) {
        const locator = f.cells ? { kind: "row", sheet: f.cells[0].sheet, row: f.cells[0].row } : f.page ? { kind: "pdf_line", page: f.page, start: f.start, end: f.end } : { kind: "text_span", start: f.start, end: f.end };
        await tx.query(`INSERT INTO source_fragments (document_id, fragment_id, seq, text, locator, cells) VALUES ($1,$2,$3,$4,$5,$6)`, [
          docId,
          f.id,
          seq,
          f.text,
          locator,
          f.cells ? JSON.stringify(f.cells) : null,
        ]);
      }
    });
  } catch (err) {
    // A concurrent upload of the same file won the unique key: return that import.
    const winner = (await db.query<{ id: string; status: string; error: string | null }>(
      `SELECT id, status, error FROM source_documents WHERE network_id = $1 AND sha256 = $2 AND parser_version = $3`,
      [actor.network_id, sha, pv],
    ))[0];
    if (winner) return existingResult(db, winner);
    throw err;
  }
  if (parseError) return { document_id: docId, duplicate_document: false, lots: [], duplicates: [], issues: [], ignored_instructions: [], status: "failed", error: parseError, warnings };

  // Extraction.
  let extraction: ExtractorResult;
  if (input.extractor !== "regex_baseline") {
    if (!metaExtract) extraction = { output: null, run: null, error: "Meta extraction is not configured on this server" };
    else extraction = await metaExtract(fragments, docId, sha);
  } else {
    extraction = { output: regexExtract(fragments), run: null, error: null };
  }
  const runId = newId("run");
  const runStatus = extraction.output ? "ok" : (extraction.run?.result_status ?? "failed");
  if (!extraction.output) {
    await db.query(`INSERT INTO extraction_runs (id, document_id, extractor, model_run, status) VALUES ($1,$2,$3,$4,$5)`, [runId, docId, input.extractor, extraction.run, runStatus]);
    await db.query(`UPDATE source_documents SET status = 'failed', error = $2 WHERE id = $1`, [docId, extraction.error]);
    return { document_id: docId, duplicate_document: false, lots: [], duplicates: [], issues: [], ignored_instructions: [], status: "failed", error: extraction.error, warnings };
  }

  const result = postProcessSupply(extraction.output, {
    fragments,
    sourceId: docId,
    ownerNetworkId: actor.network_id,
    synthetic: input.synthetic,
    extractionRunId: runId,
    observedAt: now.toISOString(),
  });

  return db.transaction(async (tx) => {
    await tx.query(`INSERT INTO extraction_runs (id, document_id, extractor, model_run, status, issues, ignored_instructions) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      runId,
      docId,
      input.extractor,
      extraction.run ?? { extractor: input.extractor === "regex_baseline" ? REGEX_BASELINE_VERSION : input.extractor },
      runStatus,
      JSON.stringify(result.issues),
      JSON.stringify(result.ignored_instructions),
    ]);
    const created: string[] = [];
    const duplicates: IntakeResult["duplicates"] = [];
    const issues = [...result.issues];
    for (const [i, lot] of result.lots.entries()) {
      const dup = await findDuplicate(tx, actor.network_id, lot);
      if (dup.same) {
        duplicates.push({ lot_index: i, existing_lot_id: dup.same });
        continue;
      }
      const lotId = input.lot_ids?.[i] ?? newId("lot");
      // Same reference but not provably the same lot: keep both and let the owner decide.
      const flagged = dup.possible.length
        ? { ...lot, fields: { ...lot.fields, seller_lot_ref: { ...lot.fields.seller_lot_ref, issues: [...lot.fields.seller_lot_ref.issues, `possible_duplicate_of:${dup.possible.join(",")}`] } } }
        : lot;
      for (const p of dup.possible) issues.push({ lot_index: i, field: "seller_lot_ref", code: "possible_duplicate", detail: p });
      await insertLot(tx, { ...flagged, lot_id: lotId }, docId, actor.id);
      created.push(lotId);
    }
    await tx.query(`UPDATE source_documents SET status = 'needs_review' WHERE id = $1`, [docId]);
    return {
      document_id: docId,
      duplicate_document: false,
      lots: created,
      duplicates,
      issues,
      ignored_instructions: result.ignored_instructions,
      status: "needs_review",
      error: null,
      warnings,
    };
  });
}

async function existingResult(db: Db, doc: { id: string; status: string; error: string | null }): Promise<IntakeResult> {
  const lots = await db.query<{ id: string }>(`SELECT id FROM lots WHERE source_document_id = $1 ORDER BY id`, [doc.id]);
  return {
    document_id: doc.id,
    duplicate_document: true,
    lots: lots.map((l) => l.id),
    duplicates: [],
    issues: [],
    ignored_instructions: [],
    status: doc.status === "failed" ? "failed" : "needs_review",
    error: doc.error,
    warnings: [],
  };
}

const gradeKey = (v: unknown) => (typeof v === "string" ? v.toUpperCase().replace(/[\s\-_.]/g, "") : null);

/**
 * Re-forwarded copies of a lot must not be counted twice (plan §9.5 rule 5),
 * but specs alone never merge two lots. A copy is only "the same lot" when the
 * owner, the seller reference, the grade, both dimensions and the weight are
 * all known and equal (and heat numbers agree when both sides list them).
 * Anything weaker is flagged as a possible duplicate for the owner instead.
 */
async function findDuplicate(sql: Sql, networkId: string, lot: InventoryLot): Promise<{ same: string | null; possible: string[] }> {
  const f = lot.fields;
  const ref = f.seller_lot_ref.normalized_value;
  if (!ref) return { same: null, possible: [] };
  const key = lotRefKey(ref);
  const rows = (
    await sql.query<{ id: string; data: InventoryLot }>(
      `SELECT l.id, v.data FROM lots l JOIN lot_versions v ON v.lot_id = l.id AND v.version = l.current_version
        WHERE l.owner_network_id = $1 AND l.status NOT IN ('sold','withdrawn')`,
      [networkId],
    )
  ).filter((r) => lotRefKey(r.data.fields.seller_lot_ref.normalized_value) === key);
  const possible: string[] = [];
  for (const r of rows) {
    const g = r.data.fields;
    const keys: [unknown, unknown][] = [
      [gradeKey(g.grade_raw.normalized_value), gradeKey(f.grade_raw.normalized_value)],
      [g.thickness_mm.normalized_value, f.thickness_mm.normalized_value],
      [g.width_mm.normalized_value, f.width_mm.normalized_value],
      [g.total_kg.normalized_value, f.total_kg.normalized_value],
    ];
    const heatsA = (g.heat_numbers.normalized_value ?? []) as string[];
    const heatsB = (f.heat_numbers.normalized_value ?? []) as string[];
    const heatsAgree = heatsA.length === 0 || heatsB.length === 0 || heatsA.some((h) => heatsB.map((x) => x.toUpperCase()).includes(h.toUpperCase()));
    if (keys.every(([a, b]) => a !== null && b !== null && a === b) && heatsAgree) return { same: r.id, possible: [] };
    possible.push(r.id);
  }
  return { same: null, possible };
}
