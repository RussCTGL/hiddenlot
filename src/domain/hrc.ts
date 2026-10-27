import { z } from "zod";

// HRC (hot-rolled coil) domain schema v0.1 — plan §9.
//
// Ground rules encoded here:
// - `null` means Unknown. It is never 0, "no limit" or a default pass.
// - Raw source text, deterministic normalizations, user edits and model
//   suggestions are distinct statuses and are never merged.
// - Grades are stored as written. There is no cross-standard synonym table;
//   Q235B / SS400 / S235JR are different grades until a human approves
//   otherwise for a specific demand.
// - Money is a decimal string, never a float.

export const HRC_SCHEMA_VERSION = "0.2.0";

// Matching is HRC-only in the MVP. Other forms are recognised so a plate or a
// cold-rolled coil offered against an HRC demand fails on product form instead
// of slipping through as "similar".
export const ProductForm = z.enum(["hot_rolled_coil", "hot_rolled_plate", "hot_rolled_sheet", "cold_rolled_coil"]);
export type ProductForm = z.infer<typeof ProductForm>;
export const MVP_PRODUCT_FORM = "hot_rolled_coil" as const;

export const ObservationStatus = z.enum([
  "not_stated", // source says nothing about this field; value is Unknown
  "source_stated", // value appears verbatim in the cited evidence
  "normalized", // deterministic conversion of a source_stated value (e.g. MT → kg)
  "user_confirmed", // a reviewer accepted the extracted value
  "user_corrected", // a reviewer replaced the extracted value; original kept in history
  "unresolved", // source has text for this field but it could not be normalized safely
]);

export const ReviewStatus = z.enum(["pending", "confirmed", "corrected"]);

export const EvidenceLocator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text_span"), start: z.number().int().nonnegative(), end: z.number().int().positive() }),
  z.object({ kind: z.literal("sheet_cell"), sheet: z.string(), row: z.number().int().positive(), cell: z.string() }),
  // Shown to other networks: the value is traced in the owner's private source,
  // but the quote and its location are not shared.
  z.object({ kind: z.literal("owner_private") }),
  z.object({
    kind: z.literal("pdf_text"),
    page: z.number().int().positive(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  }),
]);

export const EvidenceRef = z.object({
  source_id: z.string().min(1),
  fragment_id: z.string().min(1),
  locator: EvidenceLocator,
  quote: z.string(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const Decimal = z.string().regex(/^-?\d+(\.\d+)?$/, "decimal string");

export function fieldObservation<T extends z.ZodType>(value: T) {
  return z
    .object({
      raw_value: z.string().nullable(),
      normalized_value: value.nullable(),
      unit: z.string().nullable(),
      status: ObservationStatus,
      evidence: z.array(EvidenceRef),
      normalization: z.object({ rule: z.string(), version: z.string() }).nullable(),
      issues: z.array(z.string()),
      review: z.object({ status: ReviewStatus, reviewer_id: z.string().nullable() }),
    })
    .superRefine((obs, ctx) => {
      // TS cannot resolve the generic field type here; only nullness matters.
      const value = (obs as unknown as { normalized_value: unknown }).normalized_value;
      const needsEvidence = obs.status === "source_stated" || obs.status === "normalized";
      if (value !== null && needsEvidence && obs.evidence.length === 0) {
        ctx.addIssue({ code: "custom", message: `${obs.status} value requires evidence` });
      }
      if ((obs.status === "unresolved" || obs.status === "not_stated") && value !== null) {
        ctx.addIssue({ code: "custom", message: `${obs.status} observation must keep normalized_value null` });
      }
    });
}

export const LotCondition = z.enum(["prime", "secondary", "rejected_on_arrival", "unknown"]);
export const SurplusReason = z.enum([
  "partial_shipment_remainder",
  "rejected_on_arrival",
  "slitting_remainder",
  "cancelled_lc",
  "other",
]);
export const PriceBasis = z.enum(["per_mt", "per_lot"]);

const obsString = fieldObservation(z.string());
const obsNumber = fieldObservation(z.number());
const obsInt = fieldObservation(z.number().int().nonnegative());
const obsBool = fieldObservation(z.boolean());
const obsDate = fieldObservation(z.iso.date());
const obsDecimal = fieldObservation(Decimal);
const obsStringList = fieldObservation(z.array(z.string()));

export const InventoryLotFields = z.object({
  seller_lot_ref: obsString,
  product_form: fieldObservation(ProductForm),
  // Material
  grade_raw: obsString,
  standard_id: obsString,
  standard_edition: obsString,
  certificate_claims: obsStringList,
  heat_numbers: obsStringList,
  // Dimensions (nominal; tolerances are unknown unless stated)
  thickness_mm: obsNumber,
  width_mm: obsNumber,
  // Quantity. total weight and per-coil weight are never interchangeable.
  total_kg: obsNumber,
  piece_count: obsInt,
  splittable: obsBool,
  // Place & time. A port of loading is not assumed to be where the stock sits.
  location_country: obsString,
  location_place: obsString,
  available_from: obsDate,
  // Commercial
  price_amount: obsDecimal,
  price_currency: obsString,
  price_basis: fieldObservation(PriceBasis),
  incoterm: obsString,
  incoterm_place: obsString,
  // Quality & origin of the surplus. "Surplus" does not imply prime.
  condition: fieldObservation(LotCondition),
  defect_notes: obsString,
  surplus_reason: fieldObservation(SurplusReason),
});
export type InventoryLotFields = z.infer<typeof InventoryLotFields>;
export type InventoryLotField = keyof InventoryLotFields;

export const LotStatus = z.enum(["needs_review", "published", "sold", "withdrawn", "stale"]);

export const InventoryLot = z.object({
  schema_version: z.literal(HRC_SCHEMA_VERSION),
  lot_id: z.string().min(1),
  version: z.number().int().positive(),
  owner_network_id: z.string().min(1),
  status: LotStatus,
  fields: InventoryLotFields,
  source_ids: z.array(z.string()).min(1),
  extraction_run_id: z.string().nullable(),
  observed_at: z.iso.datetime(),
  last_verified_at: z.iso.datetime().nullable(),
  synthetic: z.boolean(),
});
export type InventoryLot = z.infer<typeof InventoryLot>;

// ---------------------------------------------------------------------------
// Demand. Entered by the buyer side, so values carry a requirement source
// instead of evidence spans. Any bound left null is Unknown, not "anything".

export const RequirementSource = z.enum(["buyer_explicit", "buyer_confirmed_after_review"]);

const NumRange = z
  .object({ min: z.number().nullable(), max: z.number().nullable(), source: RequirementSource })
  .refine((r) => r.min === null || r.max === null || r.min <= r.max, "min must be <= max");

export const SubstitutionPolicy = z.enum([
  "forbidden", // only the listed grade/standard pairs are acceptable
  "review_required", // other grades can be proposed but need engineering + buyer approval
]);

export const Demand = z.object({
  schema_version: z.literal(HRC_SCHEMA_VERSION),
  demand_id: z.string().min(1),
  version: z.number().int().positive(),
  buyer_network_id: z.string().min(1),
  title: z.string().min(1),
  product_form: z.literal(MVP_PRODUCT_FORM),
  quantity_kg: z
    .object({ min: z.number().positive(), target: z.number().positive().nullable(), max: z.number().positive() })
    .refine((q) => q.min <= q.max, "min must be <= max"),
  thickness_mm: NumRange,
  width_mm: NumRange,
  accepted_grades: z
    .array(z.object({ grade: z.string().min(1), standard_id: z.string().nullable(), edition: z.string().nullable() }))
    .min(1),
  substitution_policy: SubstitutionPolicy,
  acceptable_conditions: z.array(LotCondition.exclude(["unknown"])).min(1),
  must_have_certificates: z.array(z.string()),
  allow_partial_delivery: z.boolean(),
  allow_multi_lot: z.boolean(),
  destination: z.string().nullable(),
  need_by: z.iso.date().nullable(),
  budget: z
    .object({ amount: Decimal.refine((d) => !d.startsWith("-"), "budget must not be negative"), currency: z.string().length(3), basis: PriceBasis, incoterm: z.string(), place: z.string() })
    .nullable(),
  expires_at: z.iso.datetime().nullable(),
  synthetic: z.boolean(),
});
export type Demand = z.infer<typeof Demand>;

// ---------------------------------------------------------------------------
// Sanity bounds. These are review triggers for extraction slips such as
// "3.0" read as "30" — they are NOT product-standard limits and never make a
// lot pass or fail matching on their own.

export const SANITY_BOUNDS = {
  thickness_mm: { min: 0.8, max: 25.4 },
  width_mm: { min: 500, max: 2500 },
  total_kg: { min: 100, max: 5_000_000 },
} as const;

export function sanityIssues(field: keyof typeof SANITY_BOUNDS, value: number | null): string[] {
  if (value === null) return [];
  const b = SANITY_BOUNDS[field];
  return value < b.min || value > b.max ? [`implausible_${field}:${value}`] : [];
}

/**
 * Comparison key for seller lot references: "Lot B-030", "lot no. b-030" and
 * "B-030" are the same reference. Used for dedupe and evaluation matching only;
 * the stored value stays as written.
 */
export function lotRefKey(ref: string | null): string | null {
  if (ref === null) return null;
  const k = ref
    .toUpperCase()
    .replace(/^\s*(LOT|批号|批次)\s*(NO\.?|NUMBER|#)?\s*[:：#]?\s*/u, "")
    .replace(/\s+/g, "");
  return k || null;
}

/** A line that introduces a seller lot ("Lot B-018", "批号：B-018", "Lot no. C-7"). */
export const LOT_REF_LINE = /(?:\blot(?:\s*(?:no\.?|#|number))?|批号|批次)\s*[:：#]?\s*([A-Z]{1,3}-?\d{2,5}[A-Z]?)(?![A-Za-z0-9])/i;

/** A line that opens with a reference label ("Ref D-100", "Item 7", "编号 D-100"). Line start only, so "heat no. H24-77812" never counts. */
export const LOT_REF_LINE_START = /^\s*(?:ref(?:erence)?\.?|item|编号|编码)\s*[:：#]?\s*([A-Z]{1,3}-?\d{2,5}[A-Z]?)(?![A-Za-z0-9])/i;
