import { HRC_SCHEMA_VERSION, InventoryLotFields, type Demand, type InventoryLot } from "@/domain/hrc";

// Builders for test lots and demands. Values default to the main synthetic
// demo case (plan §7.1): SS400 HRC 3.0 × 1500, 18 t, wanted 15–20 t.

type Fields = InventoryLot["fields"];
type Obs = Fields[keyof Fields];

export const NOW = new Date("2026-10-27T12:00:00.000Z");

export function obs(value: unknown, status: Obs["status"] = "user_confirmed"): Obs {
  const stated = value !== null;
  return {
    raw_value: stated ? String(value) : null,
    normalized_value: stated ? value : null,
    unit: null,
    status: stated ? status : "not_stated",
    evidence: stated ? [{ source_id: "test", fragment_id: "L1", locator: { kind: "text_span", start: 0, end: 1 }, quote: String(value) }] : [],
    normalization: null,
    issues: [],
    review: { status: stated && status.startsWith("user_") ? "confirmed" : "pending", reviewer_id: null },
  } as Obs;
}

const DEFAULTS: Record<keyof Fields, unknown> = {
  seller_lot_ref: "B-018",
  product_form: "hot_rolled_coil",
  grade_raw: "SS400",
  standard_id: "JIS G3101",
  standard_edition: null,
  certificate_claims: ["MTC"],
  heat_numbers: ["H24-77812"],
  thickness_mm: 3,
  width_mm: 1500,
  total_kg: 18000,
  piece_count: 1,
  splittable: null,
  location_country: null,
  location_place: "Busan",
  available_from: "2026-11-02",
  price_amount: "545",
  price_currency: "USD",
  price_basis: "per_mt",
  incoterm: "CFR",
  incoterm_place: "Haiphong",
  condition: "prime",
  defect_notes: null,
  surplus_reason: "cancelled_lc",
};

export function lot(over: Partial<Record<keyof Fields, unknown>> = {}, meta: Partial<InventoryLot> = {}): InventoryLot {
  const fields = Object.fromEntries(
    (Object.keys(InventoryLotFields.shape) as (keyof Fields)[]).map((k) => [k, obs(k in over ? over[k] : DEFAULTS[k])]),
  ) as Fields;
  return {
    schema_version: HRC_SCHEMA_VERSION,
    lot_id: "lot-b-018",
    version: 1,
    owner_network_id: "net-b",
    status: "published",
    fields,
    source_ids: ["test"],
    extraction_run_id: null,
    observed_at: "2026-10-27T08:00:00.000Z",
    last_verified_at: "2026-10-27T08:00:00.000Z",
    synthetic: true,
    ...meta,
  };
}

export function demand(over: Partial<Demand> = {}): Demand {
  return {
    schema_version: HRC_SCHEMA_VERSION,
    demand_id: "dem-a-01",
    version: 1,
    buyer_network_id: "net-a",
    title: "HRC SS400 3.0 × 1500 for Haiphong",
    product_form: "hot_rolled_coil",
    quantity_kg: { min: 15000, target: 18000, max: 20000 },
    thickness_mm: { min: 2.95, max: 3.05, source: "buyer_explicit" },
    width_mm: { min: 1495, max: 1505, source: "buyer_explicit" },
    accepted_grades: [{ grade: "SS400", standard_id: "JIS G3101", edition: null }],
    substitution_policy: "review_required",
    acceptable_conditions: ["prime"],
    must_have_certificates: ["MTC"],
    allow_partial_delivery: false,
    allow_multi_lot: false,
    destination: "Haiphong",
    need_by: "2026-11-20",
    budget: { amount: "560", currency: "USD", basis: "per_mt", incoterm: "CFR", place: "Haiphong" },
    expires_at: null,
    synthetic: true,
    ...over,
  };
}
