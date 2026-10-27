import { readFileSync } from "node:fs";
import path from "node:path";
import { findSpan, type ExtractedLot, type SupplyExtraction } from "@/ai/tasks/extract-supply";
import type { MetaExtract } from "@/ingestion/intake";
import type { TextFragment } from "@/ingestion/text-fragments";

// Loader for the hand-written synthetic truth in data/synthetic/demo.
// The canonical extractor turns that truth into the same claim shape a model
// returns, so seed data passes the same evidence checks as live extraction.

export const DEMO_DIR = path.join(process.cwd(), "data", "synthetic", "demo");

type FieldTruth = [unknown, string] | [unknown, string, string | null];

export interface CanonicalLot {
  lot_id: string;
  anchor: string;
  fields: Partial<Record<keyof ExtractedLot, FieldTruth>>;
}

export interface CanonicalDocument {
  id: string;
  network_id: string;
  uploaded_by: string;
  kind: "text" | "csv" | "xlsx" | "pdf";
  file: string;
  lots: CanonicalLot[];
  /** Instructions planted in the document that a correct extraction must report and ignore. */
  ignored_instructions?: { note: string; anchor: string }[];
  lines?: string[];
  sheet?: string;
  rows?: string[][];
}

export interface Canonical {
  dataset: string;
  version: string;
  networks: { id: string; name: string; alias: string; region: string }[];
  users: { id: string; network_id: string; name: string; role: "trader" | "reviewer" }[];
  documents: CanonicalDocument[];
  grants: { id: string; owner_network_id: string; recipient_network_id: string; lot_id: string | null; field_scope: "all" | string[]; allow_identity_disclosure: boolean; allow_model_processing: boolean; created_by: string }[];
  demands: (Record<string, unknown> & { demand_id: string; buyer_network_id: string; created_by: string })[];
  expected: Record<string, Record<string, string>>;
  why: Record<string, string>;
}

export type DataSet = "demo" | "eval" | "eval2" | "eval3" | "eval4";

// Paths stay statically scoped to data/synthetic/<set> so builds do not trace the whole project.
const setDir = (set: DataSet) =>
  set === "demo"
    ? path.join(process.cwd(), "data", "synthetic", "demo")
    : set === "eval"
      ? path.join(process.cwd(), "data", "synthetic", "eval")
      : set === "eval2"
        ? path.join(process.cwd(), "data", "synthetic", "eval2")
        : set === "eval3"
          ? path.join(process.cwd(), "data", "synthetic", "eval3")
          : path.join(process.cwd(), "data", "synthetic", "eval4");

export function loadCanonical(set: DataSet = "demo"): Canonical {
  return JSON.parse(readFileSync(path.join(setDir(set), "canonical.json"), "utf8")) as Canonical;
}

export function documentBytes(doc: CanonicalDocument, set: DataSet = "demo"): Uint8Array {
  return new Uint8Array(readFileSync(path.join(setDir(set), path.basename(doc.file))));
}

const LIST_FIELDS = new Set(["certificate_claims", "heat_numbers"]);
const NUMBER_FIELDS = new Set(["thickness", "width", "total_weight"]);
const ALL_KEYS: (keyof ExtractedLot)[] = [
  "seller_lot_ref", "product_form", "grade", "standard_id", "standard_edition", "certificate_claims", "heat_numbers",
  "thickness", "width", "total_weight", "piece_count", "splittable", "location_country", "location_place",
  "available_from", "price_amount", "price_currency", "price_basis", "incoterm", "incoterm_place", "condition",
  "defect_notes", "surplus_reason",
];

/** Fragments that belong to each canonical lot, plus the shared preamble. */
export function sectionFragments(doc: CanonicalDocument, fragments: TextFragment[]) {
  const anchorIdx = doc.lots.map((l) => fragments.findIndex((f) => f.text.includes(l.anchor)));
  anchorIdx.forEach((idx, i) => {
    if (idx < 0) throw new Error(`${doc.id}: anchor "${doc.lots[i].anchor}" not found`);
  });
  const preamble = fragments.slice(0, Math.min(...anchorIdx));
  return doc.lots.map((lot, i) => {
    if (doc.kind === "csv" || doc.kind === "xlsx") return { lot, own: [fragments[anchorIdx[i]]], preamble };
    const next = anchorIdx.filter((x) => x > anchorIdx[i]).sort((a, b) => a - b)[0] ?? fragments.length;
    return { lot, own: fragments.slice(anchorIdx[i], next), preamble };
  });
}

/** Builds the claims the canonical truth implies, citing the fragment that contains each raw string. */
export function canonicalClaims(doc: CanonicalDocument, fragments: TextFragment[]): SupplyExtraction {
  const lots = sectionFragments(doc, fragments).map(({ lot, own, preamble }) => {
    const out = {} as Record<string, unknown>;
    for (const key of ALL_KEYS) {
      const truth = lot.fields[key];
      const empty = LIST_FIELDS.has(key) ? { value: [], raw: null, evidence: [] } : { value: null, raw: null, evidence: [] };
      if (!truth) {
        out[key] = NUMBER_FIELDS.has(key) ? { ...empty, unit: null } : empty;
        continue;
      }
      const [value, raw, unit] = truth;
      const frag = [...own, ...preamble].find((f) => findSpan(raw, f.text));
      if (!frag) throw new Error(`${doc.id}/${lot.lot_id}.${key}: raw "${raw}" not found in its section`);
      out[key] = NUMBER_FIELDS.has(key) ? { value, unit: unit ?? null, raw, evidence: [frag.id] } : { value, raw, evidence: [frag.id] };
    }
    return out as unknown as ExtractedLot;
  });
  const ignored = (doc.ignored_instructions ?? []).map((ins) => {
    const frag = fragments.find((f) => f.text.includes(ins.anchor));
    if (!frag) throw new Error(`${doc.id}: ignored-instruction anchor "${ins.anchor}" not found`);
    return { note: ins.note, evidence: [frag.id] };
  });
  return { lots, ambiguities: [], ignored_instructions: ignored };
}

export function canonicalExtractor(doc: CanonicalDocument): MetaExtract {
  return async (fragments) => ({ output: canonicalClaims(doc, fragments), run: null, error: null });
}
