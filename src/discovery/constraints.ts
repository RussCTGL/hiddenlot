import type { Demand, InventoryLot, InventoryLotField, InventoryLotFields } from "@/domain/hrc";

// Specification Compatibility & Evidence Engine (plan §11).
//
// Deterministic and model-free. Each check returns pass / fail / unknown /
// review / conditional, the lot fields it relied on, and who has to act next.
// Aggregation follows the guardrail priority in §11.4: a known fail can never
// be outweighed by a score, and a critical Unknown is never filled in by a
// guess or a confidence number.

// v2: the same grade under another standard or edition follows the substitution policy.
export const RULES_VERSION = "rules.v2";

/** Synthetic default; real windows come from partners (plan §12.4). */
export const FRESHNESS_WINDOW_HOURS = 48;

/** Hours since the owner last confirmed the stock. */
export const stockAgeHours = (lot: InventoryLot, now: Date) => (now.getTime() - new Date(lot.last_verified_at ?? lot.observed_at).getTime()) / 3_600_000;
export const isFresh = (lot: InventoryLot, now: Date) => stockAgeHours(lot, now) <= FRESHNESS_WINDOW_HOURS;

export type CheckStatus = "pass" | "conditional" | "review" | "unknown" | "fail" | "not_checked";

/** What a passing check rests on. */
export type Basis =
  | "reviewed" // owner confirmed or corrected the field after extraction
  | "source_evidence" // value traced to a source span but not reviewed
  | "seller_claim" // the seller says so (e.g. "MTC available"); the document itself is not verified
  | "grade_only" // grade matches; buyer did not require a standard
  | "not_required" // buyer did not require it and the lot does not state it
  | "system"; // access, status, dates computed by HiddenLot

export type Party = "seller" | "buyer" | "engineering" | "system";

export type CheckId =
  | "access"
  | "lot_status"
  | "freshness"
  | "product_form"
  | "condition"
  | "grade"
  | "standard"
  | "thickness"
  | "width"
  | "quantity"
  | "certificates"
  | "available_date"
  | "heat_link";

export interface Check {
  id: CheckId;
  label: string;
  status: CheckStatus;
  detail: string;
  fields: InventoryLotField[];
  basis: Basis | null;
  ask: Party | null;
}

export type CompatibilityStatus =
  | "evidence_supported"
  | "declared_match"
  | "conditional_candidate"
  | "engineering_review_required"
  | "insufficient_evidence"
  | "incompatible";

export interface AccessContext {
  own: boolean;
  grant_id: string | null;
  withheld: InventoryLotField[]; // fields the owner did not share with this network
}

export interface Assessment {
  rules_version: string;
  compatibility_status: CompatibilityStatus;
  checks: Check[];
}

type Obs = InventoryLotFields[InventoryLotField];

const KNOWN = new Set(["source_stated", "normalized", "user_confirmed", "user_corrected"]);

function known<T>(obs: Obs): T | null {
  return KNOWN.has(obs.status) ? (obs.normalized_value as T | null) : null;
}

function basisOf(...obs: Obs[]): Basis {
  return obs.every((o) => o.status === "user_confirmed" || o.status === "user_corrected") ? "reviewed" : "source_evidence";
}

/** Grade labels compare case-, space- and hyphen-insensitively. Nothing else. */
export const gradeLabel = (s: string) => s.toUpperCase().replace(/[\s\-_.]/g, "");
const stdLabel = (s: string) => s.toUpperCase().replace(/[\s\-_.:]/g, "");
const certLabel = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));
const fmtKg = (kg: number) => `${fmt(kg / 1000)} t`;

function withheldCheck(id: CheckId, label: string, fields: InventoryLotField[]): Check {
  return { id, label, status: "unknown", detail: "Not shared by the lot owner for this network", fields, basis: null, ask: "seller" };
}

export function evaluateConstraints(lot: InventoryLot, demand: Demand, access: AccessContext, now: Date): Assessment {
  const f = lot.fields;
  const withheld = new Set(access.withheld);
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const isWithheld = (...fields: InventoryLotField[]) => fields.some((x) => withheld.has(x));

  // 1. Access and purpose. Unauthorized lots never reach this function; this
  // records which authorization the assessment relied on.
  add({
    id: "access",
    label: "Authorized for discovery",
    status: "pass",
    detail: access.own ? "Lot belongs to the buyer's own network" : `Shared for discovery under grant ${access.grant_id}`,
    fields: [],
    basis: "system",
    ask: null,
  });

  // 2. Inventory validity.
  if (lot.status === "sold" || lot.status === "withdrawn") {
    add({ id: "lot_status", label: "Lot still available", status: "fail", detail: `Lot is ${lot.status}`, fields: [], basis: "system", ask: null });
  } else if (lot.status !== "published") {
    add({ id: "lot_status", label: "Lot still available", status: "unknown", detail: `Lot is ${lot.status}`, fields: [], basis: "system", ask: "seller" });
  } else {
    add({ id: "lot_status", label: "Lot still available", status: "pass", detail: "Published by owner", fields: [], basis: "system", ask: null });
  }

  const ageH = stockAgeHours(lot, now);
  add(
    isFresh(lot, now)
      ? { id: "freshness", label: "Stock recently confirmed", status: "pass", detail: `Confirmed ${fmt(Math.max(0, Math.round(ageH)))} h ago (window ${FRESHNESS_WINDOW_HOURS} h)`, fields: [], basis: "system", ask: null }
      : { id: "freshness", label: "Stock recently confirmed", status: "unknown", detail: `Last confirmed ${fmt(Math.round(ageH))} h ago; ask seller to reconfirm`, fields: [], basis: "system", ask: "seller" },
  );

  // 3. Product form and condition.
  if (isWithheld("product_form")) add(withheldCheck("product_form", "Product form", ["product_form"]));
  else {
    const form = known<string>(f.product_form);
    add(
      form === null
        ? { id: "product_form", label: "Product form", status: "unknown", detail: "Product form not stated", fields: ["product_form"], basis: null, ask: "seller" }
        : form !== demand.product_form
          ? { id: "product_form", label: "Product form", status: "fail", detail: `Lot is ${form.replaceAll("_", " ")}; demand is ${demand.product_form.replaceAll("_", " ")}`, fields: ["product_form"], basis: basisOf(f.product_form), ask: null }
          : { id: "product_form", label: "Product form", status: "pass", detail: form.replaceAll("_", " "), fields: ["product_form"], basis: basisOf(f.product_form), ask: null },
    );
  }

  if (isWithheld("condition")) add(withheldCheck("condition", "Condition", ["condition"]));
  else {
    const cond = known<string>(f.condition);
    const accepted = demand.acceptable_conditions as string[];
    if (cond === null || cond === "unknown") {
      add({ id: "condition", label: "Condition", status: "unknown", detail: "Condition not stated (surplus does not imply prime)", fields: ["condition"], basis: null, ask: "seller" });
    } else if (!accepted.includes(cond)) {
      add({ id: "condition", label: "Condition", status: "fail", detail: `Lot is ${cond.replaceAll("_", " ")}; buyer accepts ${accepted.join(", ")}`, fields: ["condition"], basis: basisOf(f.condition), ask: null });
    } else if (cond !== "prime" && known<string>(f.defect_notes) === null) {
      add({ id: "condition", label: "Condition", status: "unknown", detail: `${cond.replaceAll("_", " ")} without stated defects`, fields: ["condition", "defect_notes"], basis: null, ask: "seller" });
    } else {
      add({ id: "condition", label: "Condition", status: "pass", detail: cond.replaceAll("_", " "), fields: ["condition"], basis: basisOf(f.condition), ask: null });
    }
  }

  // 4. Grade and standard. No equivalence table: a grade is accepted only if
  // the buyer listed it.
  if (isWithheld("grade_raw")) {
    add(withheldCheck("grade", "Grade", ["grade_raw"]));
  } else {
    const grade = known<string>(f.grade_raw);
    const matches = grade === null ? [] : demand.accepted_grades.filter((g) => gradeLabel(g.grade) === gradeLabel(grade));
    const listed = demand.accepted_grades.map((g) => g.grade).join(" / ");
    if (grade === null) {
      add({ id: "grade", label: "Grade", status: "unknown", detail: "Grade not stated", fields: ["grade_raw"], basis: null, ask: "seller" });
    } else if (matches.length > 0) {
      add({ id: "grade", label: "Grade", status: "pass", detail: `${grade} is on the buyer's accepted list`, fields: ["grade_raw"], basis: basisOf(f.grade_raw), ask: null });
      add(standardCheck(lot, matches, isWithheld("standard_id", "standard_edition"), demand.substitution_policy));
    } else if (demand.substitution_policy === "forbidden") {
      add({ id: "grade", label: "Grade", status: "fail", detail: `${grade} is not ${listed}; buyer does not allow substitution`, fields: ["grade_raw"], basis: basisOf(f.grade_raw), ask: null });
    } else {
      add({ id: "grade", label: "Grade", status: "review", detail: `${grade} is not ${listed}. A different grade needs engineering review and buyer approval; HiddenLot does not treat grades as equivalent`, fields: ["grade_raw"], basis: basisOf(f.grade_raw), ask: "engineering" });
    }
  }

  // 5. Dimensions: nominal value inside the buyer's explicit range.
  add(rangeCheck("thickness", "Thickness", "thickness_mm", "mm", f.thickness_mm, demand.thickness_mm, isWithheld("thickness_mm")));
  add(rangeCheck("width", "Width", "width_mm", "mm", f.width_mm, demand.width_mm, isWithheld("width_mm")));

  // 6. Quantity. Total lot weight against the buyer's bounds. Lots are never
  // combined automatically, and a single coil is never assumed divisible.
  if (isWithheld("total_kg")) add(withheldCheck("quantity", "Quantity", ["total_kg"]));
  else {
    const kg = known<number>(f.total_kg);
    const { min, max } = demand.quantity_kg;
    const want = `${fmtKg(min)}–${fmtKg(max)}`;
    if (kg === null || f.total_kg.issues.some((i) => i.startsWith("implausible_"))) {
      add({ id: "quantity", label: "Quantity", status: "unknown", detail: kg === null ? "Total weight unknown (unit missing or ambiguous)" : `${fmtKg(kg)} looks implausible; recheck`, fields: ["total_kg"], basis: null, ask: "seller" });
    } else if (kg < min) {
      add(
        demand.allow_partial_delivery
          ? { id: "quantity", label: "Quantity", status: "conditional", detail: `${fmtKg(kg)} covers part of ${want}; buyer allows partial delivery`, fields: ["total_kg"], basis: basisOf(f.total_kg), ask: "buyer" }
          : { id: "quantity", label: "Quantity", status: "fail", detail: `${fmtKg(kg)} is below the ${fmtKg(min)} minimum; partial delivery not allowed${demand.allow_multi_lot ? " (lots are not combined automatically)" : ""}`, fields: ["total_kg"], basis: basisOf(f.total_kg), ask: null },
      );
    } else if (kg > max) {
      const split = isWithheld("splittable") ? null : known<boolean>(f.splittable);
      const pieces = known<number>(f.piece_count);
      if (split === false || pieces === 1) {
        add({ id: "quantity", label: "Quantity", status: "fail", detail: `${fmtKg(kg)} exceeds the ${fmtKg(max)} maximum and ${pieces === 1 ? "is a single coil" : "seller will not split the lot"}`, fields: ["total_kg", "splittable", "piece_count"], basis: basisOf(f.total_kg), ask: null });
      } else if (split === true) {
        add({ id: "quantity", label: "Quantity", status: "conditional", detail: `${fmtKg(kg)} exceeds ${fmtKg(max)}; seller states the lot can be split — confirm a partial sale`, fields: ["total_kg", "splittable"], basis: basisOf(f.total_kg, f.splittable), ask: "seller" });
      } else {
        add({ id: "quantity", label: "Quantity", status: "unknown", detail: `${fmtKg(kg)} exceeds ${fmtKg(max)}; whether the seller will split it is unknown`, fields: ["total_kg", "splittable"], basis: null, ask: "seller" });
      }
    } else {
      add({ id: "quantity", label: "Quantity", status: "pass", detail: `${fmtKg(kg)} within ${want}`, fields: ["total_kg"], basis: basisOf(f.total_kg), ask: null });
    }
  }

  // 7. Certificates. A seller's claim is recorded as a claim; HiddenLot cannot
  // verify that a certificate exists or is genuine.
  if (demand.must_have_certificates.length === 0) {
    add({ id: "certificates", label: "Certificates", status: "pass", detail: "Buyer requires none", fields: [], basis: "system", ask: null });
  } else if (isWithheld("certificate_claims")) {
    add(withheldCheck("certificates", "Certificates", ["certificate_claims"]));
  } else {
    // Exact names only: "NO MTC" or "EN 10204 2.1" never satisfy "MTC" or "EN 10204 2".
    const claims = new Set((known<string[]>(f.certificate_claims) ?? []).map(certLabel));
    const missing = demand.must_have_certificates.filter((req) => !claims.has(certLabel(req)));
    add(
      missing.length === 0
        ? { id: "certificates", label: "Certificates", status: "pass", detail: `Seller states ${demand.must_have_certificates.join(", ")} available (not verified)`, fields: ["certificate_claims"], basis: "seller_claim", ask: null }
        : { id: "certificates", label: "Certificates", status: "unknown", detail: `No statement about ${missing.join(", ")}`, fields: ["certificate_claims"], basis: null, ask: "seller" },
    );
  }

  // 9. Timing. Transit time is not modelled, so a pass here only means the
  // stock is available before the need-by date.
  if (demand.need_by === null) {
    const from = isWithheld("available_from") ? null : known<string>(f.available_from);
    // No deadline is not the same as a known date: an unstated date keeps the
    // candidate out of evidence_supported (plan §9.4).
    add(
      from === null
        ? { id: "available_date", label: "Available before need-by", status: "pass", detail: "Buyer set no need-by date; availability date not stated", fields: ["available_from"], basis: "not_required", ask: null }
        : { id: "available_date", label: "Available before need-by", status: "pass", detail: `Available ${from}; buyer set no need-by date`, fields: ["available_from"], basis: basisOf(f.available_from), ask: null },
    );
  } else if (isWithheld("available_from")) {
    add(withheldCheck("available_date", "Available before need-by", ["available_from"]));
  } else {
    const from = known<string>(f.available_from);
    add(
      from === null
        ? { id: "available_date", label: "Available before need-by", status: "unknown", detail: `Availability date not stated; buyer needs it by ${demand.need_by}`, fields: ["available_from"], basis: null, ask: "seller" }
        : from > demand.need_by
          ? { id: "available_date", label: "Available before need-by", status: "fail", detail: `Available ${from}, after need-by ${demand.need_by}`, fields: ["available_from"], basis: basisOf(f.available_from), ask: null }
          : { id: "available_date", label: "Available before need-by", status: "pass", detail: `Available ${from}; need-by ${demand.need_by} (transit time not included)`, fields: ["available_from"], basis: basisOf(f.available_from), ask: null },
    );
  }

  // 8. Batch link between certificate and stock is a document check (P1).
  if (demand.must_have_certificates.length > 0) {
    add({ id: "heat_link", label: "Certificate belongs to this lot", status: "not_checked", detail: "Needs the certificate document; matching heat numbers is a human/document step", fields: ["heat_numbers"], basis: null, ask: "seller" });
  }

  return { rules_version: RULES_VERSION, compatibility_status: aggregate(checks), checks };
}

/**
 * The same grade name under a different standard or edition is not the listed
 * specification (no cross-standard synonyms). Like a different grade, it fails
 * when the buyer forbids substitution and needs engineering review otherwise.
 */
function standardCheck(lot: InventoryLot, matches: Demand["accepted_grades"], withheld: boolean, policy: Demand["substitution_policy"]): Check {
  const f = lot.fields;
  const fields: InventoryLotField[] = ["standard_id", "standard_edition"];
  const required = matches.filter((m) => m.standard_id !== null);
  if (required.length === 0) {
    const std = known<string>(f.standard_id);
    return { id: "standard", label: "Standard", status: "pass", detail: `Buyer did not require a standard${std ? `; lot states ${std}` : ""}`, fields, basis: "grade_only", ask: null };
  }
  if (withheld) return withheldCheck("standard", "Standard", fields);

  const std = known<string>(f.standard_id);
  const edition = known<string>(f.standard_edition);
  const wanted = required.map((m) => `${m.standard_id}${m.edition ? `:${m.edition}` : ""}`).join(" or ");
  if (std === null) {
    return { id: "standard", label: "Standard", status: "unknown", detail: `Standard not stated; buyer requires ${wanted}`, fields, basis: null, ask: "seller" };
  }
  const sameStd = required.filter((m) => stdLabel(m.standard_id!) === stdLabel(std));
  if (sameStd.length === 0) {
    return policy === "forbidden"
      ? { id: "standard", label: "Standard", status: "fail", detail: `Lot states ${std}; buyer requires ${wanted} and allows no substitution`, fields, basis: basisOf(f.standard_id), ask: null }
      : { id: "standard", label: "Standard", status: "review", detail: `Lot states ${std}; buyer requires ${wanted}. A grade under another standard needs engineering review and buyer approval`, fields, basis: basisOf(f.standard_id), ask: "engineering" };
  }
  if (sameStd.some((m) => m.edition === null)) {
    return { id: "standard", label: "Standard", status: "pass", detail: `${std} (buyer did not require an edition)`, fields, basis: basisOf(f.standard_id), ask: null };
  }
  if (edition === null) {
    return { id: "standard", label: "Standard", status: "unknown", detail: `${std} edition not stated; buyer requires ${wanted}. HiddenLot does not assume an edition`, fields, basis: null, ask: "seller" };
  }
  return sameStd.some((m) => stdLabel(m.edition!) === stdLabel(edition))
    ? { id: "standard", label: "Standard", status: "pass", detail: `${std}:${edition}`, fields, basis: basisOf(f.standard_id, f.standard_edition), ask: null }
    : policy === "forbidden"
      ? { id: "standard", label: "Standard", status: "fail", detail: `Lot states ${std}:${edition}; buyer requires ${wanted} and allows no substitution`, fields, basis: basisOf(f.standard_edition), ask: null }
      : { id: "standard", label: "Standard", status: "review", detail: `Lot states ${std}:${edition}; buyer requires ${wanted}. Another edition needs engineering review`, fields, basis: basisOf(f.standard_edition), ask: "engineering" };
}

function rangeCheck(
  id: CheckId,
  label: string,
  field: "thickness_mm" | "width_mm",
  unit: string,
  obs: Obs,
  range: Demand["thickness_mm"],
  withheld: boolean,
): Check {
  if (withheld) return withheldCheck(id, label, [field]);
  if (range.min === null && range.max === null) {
    return { id, label, status: "unknown", detail: "Buyer has not set a range", fields: [field], basis: null, ask: "buyer" };
  }
  const v = known<number>(obs);
  const want = `${range.min ?? "?"}–${range.max ?? "?"} ${unit}`;
  if (v === null) {
    return { id, label, status: "unknown", detail: `${label} unknown${obs.issues.length ? ` (${obs.issues.join(", ")})` : ""}; buyer needs ${want}`, fields: [field], basis: null, ask: "seller" };
  }
  if (obs.issues.some((i) => i.startsWith("implausible_"))) {
    return { id, label, status: "unknown", detail: `${fmt(v)} ${unit} looks implausible; recheck the source`, fields: [field], basis: null, ask: "seller" };
  }
  const eps = 1e-9;
  const inside = (range.min === null || v >= range.min - eps) && (range.max === null || v <= range.max + eps);
  if (!inside) return { id, label, status: "fail", detail: `${fmt(v)} ${unit} outside ${want}`, fields: [field], basis: basisOf(obs), ask: null };
  if (range.min === null || range.max === null) {
    return { id, label, status: "unknown", detail: `${fmt(v)} ${unit}; buyer range is open on one side (${want})`, fields: [field], basis: basisOf(obs), ask: "buyer" };
  }
  return { id, label, status: "pass", detail: `${fmt(v)} ${unit} within ${want} (nominal; tolerance not stated)`, fields: [field], basis: basisOf(obs), ask: null };
}

export function aggregate(checks: Check[]): CompatibilityStatus {
  const relevant = checks.filter((c) => c.status !== "not_checked");
  if (relevant.some((c) => c.status === "fail")) return "incompatible";
  if (relevant.some((c) => c.status === "review")) return "engineering_review_required";
  if (relevant.some((c) => c.status === "unknown")) return "insufficient_evidence";
  if (relevant.some((c) => c.status === "conditional")) return "conditional_candidate";
  const declaredOnly = relevant.some((c) => c.basis !== null && c.basis !== "reviewed" && c.basis !== "system");
  return declaredOnly ? "declared_match" : "evidence_supported";
}

export const STATUS_LABEL: Record<CompatibilityStatus, string> = {
  evidence_supported: "Evidence supported",
  declared_match: "Declared spec match",
  conditional_candidate: "Conditional candidate",
  engineering_review_required: "Engineering review required",
  insufficient_evidence: "Insufficient evidence",
  incompatible: "Incompatible",
};

/** Groups a reviewer works through in order; incompatible is diagnostics only. */
export const REVIEWABLE: CompatibilityStatus[] = ["evidence_supported", "declared_match", "conditional_candidate"];
