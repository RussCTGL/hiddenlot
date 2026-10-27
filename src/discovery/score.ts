import type { Demand, InventoryLot } from "@/domain/hrc";
import { FRESHNESS_WINDOW_HOURS } from "./constraints";

// Review-priority score (plan §12.2). This is NOT a probability of a deal,
// of material conformity, or a credit rating. Unknown components are left
// out rather than filled with a neutral value, and the UI shows the
// interval and coverage, not just the observed score.

export const SCORE_VERSION = "score.v1";

export const WEIGHTS = { fit: 0.3, availability: 0.2, delivery: 0.15, economics: 0.2, evidence: 0.15 } as const;
export type Dimension = keyof typeof WEIGHTS;

export interface Component {
  value: number | null; // [0,1], null = unknown
  note: string;
}

// Goods price against budget on the same basis. Freight, duty and FX are not
// filled in, so "within_budget" is never a profit claim.
export type Commercial = "within_budget" | "over_budget" | "unknown";

export interface Score {
  version: string;
  components: Record<Dimension, Component>;
  coverage: number;
  observed: number | null;
  lower: number | null;
  upper: number | null;
  commercial: Commercial;
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

const CRITICAL_FIELDS = ["product_form", "grade_raw", "standard_id", "thickness_mm", "width_mm", "total_kg", "condition"] as const;

export function scoreCandidate(lot: InventoryLot, demand: Demand, now: Date): Score {
  const f = lot.fields;
  const num = (o: { status: string; normalized_value: unknown }) =>
    o.status === "not_stated" || o.status === "unresolved" ? null : (o.normalized_value as number | null);

  // fit: how close the lot is to the buyer's target quantity.
  const kg = num(f.total_kg);
  const target = demand.quantity_kg.target;
  const fit: Component =
    kg === null || target === null
      ? { value: null, note: target === null ? "Buyer set no target quantity" : "Lot weight unknown" }
      : { value: clamp(1 - Math.abs(kg - target) / target), note: `${kg / 1000} t vs target ${target / 1000} t` };

  // availability: freshness of the last stock confirmation.
  const verified = lot.last_verified_at ?? lot.observed_at;
  const ageH = (now.getTime() - new Date(verified).getTime()) / 3_600_000;
  const availability: Component = { value: clamp(1 - ageH / FRESHNESS_WINDOW_HOURS), note: `Confirmed ${Math.max(0, Math.round(ageH))} h ago` };

  // delivery: slack between availability and need-by. Transit is not modelled.
  const from = num(f.available_from) as unknown as string | null;
  const delivery: Component =
    demand.need_by === null || from === null
      ? { value: null, note: demand.need_by === null ? "No need-by date" : "Availability date unknown" }
      : (() => {
          const slackDays = (Date.parse(demand.need_by) - Date.parse(from)) / 86_400_000;
          return { value: clamp(slackDays / 30), note: `${Math.round(slackDays)} days before need-by (transit not included)` };
        })();

  // economics: price vs budget, only when both are on the same basis.
  const { economics, commercial } = economicsOf(lot, demand);

  // evidence: share of critical fields that are traced to a source span and
  // reviewed by the owner. Not a model confidence.
  const reviewed = CRITICAL_FIELDS.filter((k) => {
    const o = f[k];
    return (o.status === "user_confirmed" || o.status === "user_corrected") && o.evidence.length > 0;
  }).length;
  const evidence: Component = { value: reviewed / CRITICAL_FIELDS.length, note: `${reviewed}/${CRITICAL_FIELDS.length} critical fields traced and reviewed` };

  const components = { fit, availability, delivery, economics, evidence };
  let coverage = 0;
  let weighted = 0;
  for (const [k, w] of Object.entries(WEIGHTS) as [Dimension, number][]) {
    const v = components[k].value;
    if (v === null) continue;
    coverage += w;
    weighted += w * v;
  }
  if (coverage === 0) return { version: SCORE_VERSION, components, coverage: 0, observed: null, lower: null, upper: null, commercial };
  return {
    version: SCORE_VERSION,
    components,
    coverage: round1(coverage * 100) / 100,
    observed: round1((100 * weighted) / coverage),
    lower: round1(100 * weighted),
    upper: round1(100 * weighted + 100 * (1 - coverage)),
    commercial,
  };
}

function economicsOf(lot: InventoryLot, demand: Demand): { economics: Component; commercial: Commercial } {
  const f = lot.fields;
  const unknown = (note: string) => ({ economics: { value: null, note }, commercial: "unknown" as const });
  const b = demand.budget;
  if (b === null) return unknown("Buyer set no budget");
  const val = (o: { status: string; normalized_value: unknown }) =>
    o.status === "not_stated" || o.status === "unresolved" ? null : (o.normalized_value as string | null);
  const amount = val(f.price_amount);
  if (amount === null) return unknown("No price stated");
  const currency = val(f.price_currency);
  const basis = val(f.price_basis);
  const incoterm = val(f.incoterm);
  const place = val(f.incoterm_place);
  // Only compare like with like; no FX, freight or duty is filled in from general knowledge.
  if (currency !== b.currency || basis !== b.basis || incoterm?.toUpperCase() !== b.incoterm.toUpperCase() || place?.toLowerCase() !== b.place.toLowerCase()) {
    return unknown(`Price ${currency ?? "?"} ${amount} ${basis ?? "?"} ${incoterm ?? "?"} ${place ?? "?"} is not on the budget basis ${b.currency} ${b.basis} ${b.incoterm} ${b.place}`);
  }
  // Exact decimal comparison (no float accounting); the margin is display only.
  const cmp = compareDecimal(amount, b.amount);
  const budgetNum = Number(b.amount);
  if (!(budgetNum > 0)) return unknown("Budget is zero or invalid");
  const margin = (budgetNum - Number(amount)) / budgetNum;
  return {
    economics: { value: clamp(0.5 + margin * 5), note: `${currency} ${amount} vs budget ${b.amount} (${(margin * 100).toFixed(1)}% headroom, goods price only)` },
    commercial: cmp <= 0 ? "within_budget" : "over_budget",
  };
}

/** Compares two non-negative decimal strings exactly. Returns -1, 0 or 1. */
export function compareDecimal(a: string, b: string): number {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(scale, "0"));
  const y = BigInt(bi + bf.padEnd(scale, "0"));
  return x < y ? -1 : x > y ? 1 : 0;
}
