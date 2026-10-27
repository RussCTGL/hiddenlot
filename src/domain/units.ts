// Deterministic unit normalization. The model never converts units; it only
// reports the raw value and the unit text it saw. Anything ambiguous fails
// closed so the field stays Unknown and goes to human review.

export const UNITS_RULES_VERSION = "1";

export type NormalizeResult =
  | { ok: true; value: number; rule: string }
  | { ok: false; reason: NormalizeFailure };

export type NormalizeFailure =
  | "unit_missing"
  | "unit_unrecognized"
  | "ambiguous_ton"
  | "not_finite";

const clean = (unit: string) => unit.trim().toLowerCase().replace(/\.$/, "");

const LENGTH_TO_MM: Record<string, { factor: number; rule: string }> = {
  mm: { factor: 1, rule: "identity_mm" },
  millimeter: { factor: 1, rule: "identity_mm" },
  millimetre: { factor: 1, rule: "identity_mm" },
  毫米: { factor: 1, rule: "identity_mm" },
  cm: { factor: 10, rule: "cm_to_mm" },
  厘米: { factor: 10, rule: "cm_to_mm" },
  in: { factor: 25.4, rule: "inch_to_mm" },
  inch: { factor: 25.4, rule: "inch_to_mm" },
  inches: { factor: 25.4, rule: "inch_to_mm" },
  '"': { factor: 25.4, rule: "inch_to_mm" },
};

// "ton"/"tons" alone is deliberately absent: short, long and metric tons
// differ, so it must be confirmed by a human (plan §9.5 rule 2).
const MASS_TO_KG: Record<string, { factor: number; rule: string }> = {
  kg: { factor: 1, rule: "identity_kg" },
  kgs: { factor: 1, rule: "identity_kg" },
  公斤: { factor: 1, rule: "identity_kg" },
  千克: { factor: 1, rule: "identity_kg" },
  t: { factor: 1000, rule: "metric_tonne_to_kg" },
  mt: { factor: 1000, rule: "metric_tonne_to_kg" },
  mts: { factor: 1000, rule: "metric_tonne_to_kg" },
  tonne: { factor: 1000, rule: "metric_tonne_to_kg" },
  tonnes: { factor: 1000, rule: "metric_tonne_to_kg" },
  "metric ton": { factor: 1000, rule: "metric_tonne_to_kg" },
  "metric tons": { factor: 1000, rule: "metric_tonne_to_kg" },
  // In Chinese trade usage 吨 is the metric tonne.
  吨: { factor: 1000, rule: "cn_dun_metric_tonne_to_kg" },
  lb: { factor: 0.45359237, rule: "lb_to_kg" },
  lbs: { factor: 0.45359237, rule: "lb_to_kg" },
};

const AMBIGUOUS_MASS = new Set(["ton", "tons"]);

function convert(
  value: number,
  unit: string | null,
  table: Record<string, { factor: number; rule: string }>,
  decimals: number,
): NormalizeResult {
  if (!Number.isFinite(value)) return { ok: false, reason: "not_finite" };
  if (unit === null || unit.trim() === "") return { ok: false, reason: "unit_missing" };
  const key = clean(unit);
  if (table === MASS_TO_KG && AMBIGUOUS_MASS.has(key)) {
    return { ok: false, reason: "ambiguous_ton" };
  }
  const entry = table[key];
  if (!entry) return { ok: false, reason: "unit_unrecognized" };
  const scale = 10 ** decimals;
  return { ok: true, value: Math.round(value * entry.factor * scale) / scale, rule: entry.rule };
}

export function normalizeLengthToMm(value: number, unit: string | null): NormalizeResult {
  return convert(value, unit, LENGTH_TO_MM, 4);
}

export function normalizeMassToKg(value: number, unit: string | null): NormalizeResult {
  return convert(value, unit, MASS_TO_KG, 3);
}
