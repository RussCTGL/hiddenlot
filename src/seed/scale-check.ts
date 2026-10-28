import { getOpportunityForActor, listOpportunitiesForActor, type Actor } from "@/auth/access";
import type { Db } from "@/db/client";
import type { Demand, InventoryLot, InventoryLotField } from "@/domain/hrc";
import type { Check } from "@/discovery/constraints";
import { ALL_FIELDS, type ScaleWorld } from "./scale";

// Independent oracle for the scale test. It reads the source tables (lots,
// demands, grants) and recomputes, without engine code, which pairs a network
// may see and which pairs may be offered for review; then compares that with
// the assessments and opportunities the engine stored. Every count in the
// report should be zero.

const REVIEWABLE = ["evidence_supported", "declared_match", "conditional_candidate"];
const FRESH_HOURS = 48;
/** Shapes of the canary strings planted by the generator. */
const CANARY = /(?:SL|HT)-[0-9a-f]{12}|Yard [0-9a-f]{12}|defects [0-9a-f]{10}/g;
const WITHHELD_DETAIL ="Not shared by the lot owner for this network";
const CHECK_OF: Partial<Record<InventoryLotField, string>> = {
  product_form: "product_form",
  condition: "condition",
  grade_raw: "grade",
  thickness_mm: "thickness",
  width_mm: "width",
  total_kg: "quantity",
  certificate_claims: "certificates",
  available_from: "available_date",
};

interface LotRow {
  id: string;
  owner_network_id: string;
  status: string;
  current_version: number;
  data: InventoryLot;
}
interface DemandRow {
  id: string;
  buyer_network_id: string;
  status: string;
  current_version: number;
  data: Demand;
}
interface GrantRow {
  id: string;
  owner_network_id: string;
  recipient_network_id: string;
  lot_id: string | null;
  field_scope: InventoryLotField[];
  allow_discovery: boolean;
  allow_identity_disclosure: boolean;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}
interface AssessmentRow {
  id: string;
  lot_id: string;
  lot_version: number;
  demand_id: string;
  demand_version: number;
  permission_version: string;
  freshness: string;
  compatibility_status: string;
  checks: Check[];
  score: unknown;
}

export interface Visibility {
  perm: string;
  withheld: Set<InventoryLotField>;
  disclosed: boolean;
}

export interface ScaleReport {
  expected_pairs: number;
  open_opportunities: number;
  reviewable_open: number;
  by_status: Record<string, number>;
  /** Each of these must be zero. */
  failures: {
    missing_assessment: number;
    unauthorized_assessment: number;
    unauthorized_opportunity: number;
    outdated_open_opportunity: number;
    duplicate_open_opportunity: number;
    incompatible_open_opportunity: number;
    missing_opportunity: number;
    hard_constraint_violation: number;
    missed_clean_match: number;
    unexpected_engineering_review: number;
    withheld_field_used: number;
    withheld_value_in_assessment: number;
    leak_in_list: number;
    leak_in_detail: number;
    detail_after_access_ended: number;
  };
  examples: Partial<Record<keyof ScaleReport["failures"], string[]>>;
  views_checked: number;
}

const norm = (s: string) => s.toUpperCase().replace(/[\s\-_.:/]/g, "");
const certNorm = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();

function val<T>(lot: InventoryLot, f: InventoryLotField, withheld: Set<InventoryLotField>): T | null {
  if (withheld.has(f)) return null;
  const o = lot.fields[f];
  if (o.status === "not_stated" || o.status === "unresolved") return null;
  return o.normalized_value as T | null;
}
const implausible = (lot: InventoryLot, f: InventoryLotField) => lot.fields[f].issues.some((i) => i.startsWith("implausible_"));

/**
 * Whether a pair may be offered for review: every hard requirement is known
 * and met on what the buyer's network may see. Also reports whether a grade
 * or standard mismatch exists (the engineering-review case).
 */
export function oracle(lot: InventoryLot, d: Demand, withheld: Set<InventoryLotField>, now: Date) {
  const v = <T>(f: InventoryLotField) => val<T>(lot, f, withheld);
  const reasons: string[] = [];
  const verified = new Date(lot.last_verified_at ?? lot.observed_at).getTime();
  if ((now.getTime() - verified) / 3_600_000 > FRESH_HOURS) reasons.push("stale");
  if (lot.status !== "published") reasons.push("not published");
  if (v<string>("product_form") !== d.product_form) reasons.push("form");

  const cond = v<string>("condition");
  if (cond === null || cond === "unknown" || !(d.acceptable_conditions as string[]).includes(cond)) reasons.push("condition");
  else if (cond !== "prime" && v<string>("defect_notes") === null) reasons.push("condition without notes");

  const grade = v<string>("grade_raw");
  const listed = grade === null ? [] : d.accepted_grades.filter((g) => norm(g.grade) === norm(grade));
  let gradeMismatch = false;
  if (grade === null) reasons.push("grade unknown");
  else if (listed.length === 0) {
    reasons.push("grade not listed");
    gradeMismatch = true;
  } else {
    const required = listed.filter((g) => g.standard_id !== null);
    if (required.length > 0) {
      const std = v<string>("standard_id");
      if (std === null) reasons.push("standard unknown");
      else if (!required.some((g) => norm(g.standard_id!) === norm(std))) {
        reasons.push("standard differs");
        gradeMismatch = true;
      }
    }
  }

  for (const [f, range] of [
    ["thickness_mm", d.thickness_mm],
    ["width_mm", d.width_mm],
  ] as const) {
    const x = v<number>(f);
    if (x === null || implausible(lot, f) || range.min === null || range.max === null || x < range.min - 1e-9 || x > range.max + 1e-9) reasons.push(f);
  }

  const kg = v<number>("total_kg");
  if (kg === null || implausible(lot, "total_kg")) reasons.push("quantity unknown");
  else if (kg < d.quantity_kg.min && !d.allow_partial_delivery) reasons.push("below minimum");
  else if (kg > d.quantity_kg.max && !(v<boolean>("splittable") === true && v<number>("piece_count") !== 1)) reasons.push("above maximum");

  if (d.must_have_certificates.length > 0) {
    const claims = new Set((v<string[]>("certificate_claims") ?? []).map(certNorm));
    if (!d.must_have_certificates.every((c) => claims.has(certNorm(c)))) reasons.push("certificate");
  }
  if (d.need_by !== null) {
    const from = v<string>("available_from");
    if (from === null || from > d.need_by) reasons.push("date");
  }
  return { reviewable: reasons.length === 0, reasons, gradeMismatch };
}

export async function checkScale(db: Db, world: ScaleWorld, now: Date, opts: { deadAtLoad: Set<string>; viewsPerNetwork: number }): Promise<ScaleReport> {
  const lots = await db.query<LotRow>(
    `SELECT l.id, l.owner_network_id, l.status, l.current_version, v.data FROM lots l JOIN lot_versions v ON v.lot_id = l.id AND v.version = l.current_version`,
  );
  const demands = await db.query<DemandRow>(
    `SELECT d.id, d.buyer_network_id, d.status, d.current_version, v.data FROM demands d JOIN demand_versions v ON v.demand_id = d.id AND v.version = d.current_version`,
  );
  const grants = await db.query<GrantRow>(`SELECT * FROM sharing_grants`);
  const assessments = await db.query<AssessmentRow>(
    `SELECT id, lot_id, lot_version, demand_id, demand_version, permission_version, freshness, compatibility_status, checks, score FROM match_assessments`,
  );
  const opps = await db.query<{ id: string; assessment_id: string; demand_id: string; lot_id: string; status: string; buyer_network_id: string }>(
    `SELECT id, assessment_id, demand_id, lot_id, status, buyer_network_id FROM opportunities`,
  );

  const lotById = new Map(lots.map((l) => [l.id, l]));
  const demandById = new Map(demands.map((d) => [d.id, d]));
  const grantById = new Map(grants.map((g) => [g.id, g]));
  const assessmentById = new Map(assessments.map((a) => [a.id, a]));
  const t = now.getTime();

  const failures: ScaleReport["failures"] = {
    missing_assessment: 0,
    unauthorized_assessment: 0,
    unauthorized_opportunity: 0,
    outdated_open_opportunity: 0,
    duplicate_open_opportunity: 0,
    incompatible_open_opportunity: 0,
    missing_opportunity: 0,
    hard_constraint_violation: 0,
    missed_clean_match: 0,
    unexpected_engineering_review: 0,
    withheld_field_used: 0,
    withheld_value_in_assessment: 0,
    leak_in_list: 0,
    leak_in_detail: 0,
    detail_after_access_ended: 0,
  };
  const examples: ScaleReport["examples"] = {};
  const fail = (k: keyof typeof failures, ex: string) => {
    failures[k]++;
    const list = (examples[k] ??= []);
    if (list.length < 5) list.push(ex);
  };

  // Who may see what, recomputed from the grant rows.
  const visibility = (networkId: string, lot: LotRow): Visibility | null => {
    if (lot.status !== "published") return null;
    if (lot.owner_network_id === networkId) return { perm: "own", withheld: new Set(), disclosed: true };
    const live = grants
      .filter(
        (g) =>
          g.owner_network_id === lot.owner_network_id &&
          g.recipient_network_id === networkId &&
          (g.lot_id === null || g.lot_id === lot.id) &&
          g.allow_discovery &&
          g.revoked_at === null &&
          (g.expires_at === null || new Date(g.expires_at).getTime() > t),
      )
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || (a.id < b.id ? 1 : -1));
    const g = live[0];
    if (!g) return null;
    const scope = new Set(g.field_scope);
    return { perm: `grant:${g.id}`, withheld: new Set(ALL_FIELDS.filter((f) => !scope.has(f))), disclosed: g.allow_identity_disclosure };
  };
  const fresh = (lot: InventoryLot) => (t - new Date(lot.last_verified_at ?? lot.observed_at).getTime()) / 3_600_000 <= FRESH_HOURS;
  const leaked = (text: string, lotId: string, withheld: Set<InventoryLotField>) =>
    Object.entries(world.canaries[lotId] ?? {}).filter(([f, s]) => withheld.has(f as InventoryLotField) && text.includes(s)).map(([f]) => f);

  // Every assessment ever stored must rest on an authorization that existed.
  for (const a of assessments) {
    const lot = lotById.get(a.lot_id)!;
    const d = demandById.get(a.demand_id)!;
    if (a.permission_version === "own") {
      if (lot.owner_network_id !== d.buyer_network_id) fail("unauthorized_assessment", `${a.id}: own for ${d.buyer_network_id} on ${lot.id}`);
      continue;
    }
    const g = grantById.get(a.permission_version.slice("grant:".length));
    if (
      !g ||
      opts.deadAtLoad.has(g.id) ||
      !g.allow_discovery ||
      g.owner_network_id !== lot.owner_network_id ||
      g.recipient_network_id !== d.buyer_network_id ||
      (g.lot_id !== null && g.lot_id !== lot.id)
    ) {
      fail("unauthorized_assessment", `${a.id}: ${a.permission_version} for ${d.buyer_network_id} on ${lot.id}`);
    }
  }

  // Expected current pairs.
  const current = new Map<string, { a: AssessmentRow; vis: Visibility; lot: LotRow; demand: DemandRow }>();
  let expected = 0;
  const assessmentIndex = new Map(assessments.map((a) => [`${a.demand_id}|${a.demand_version}|${a.lot_id}|${a.lot_version}|${a.permission_version}|${a.freshness}`, a]));
  for (const d of demands) {
    if (d.status !== "active" || (d.data.expires_at !== null && new Date(d.data.expires_at).getTime() <= t)) continue;
    for (const lot of lots) {
      const vis = visibility(d.buyer_network_id, lot);
      if (!vis) continue;
      expected++;
      const a = assessmentIndex.get(`${d.id}|${d.current_version}|${lot.id}|${lot.current_version}|${vis.perm}|${fresh(lot.data) ? "fresh" : "stale"}`);
      if (!a) {
        fail("missing_assessment", `${d.id} × ${lot.id} (${vis.perm})`);
        continue;
      }
      current.set(`${d.id}|${lot.id}`, { a, vis, lot, demand: d });
    }
  }

  // Assessment content: withheld fields never decide a check, withheld values never appear.
  for (const { a, vis, lot, demand } of current.values()) {
    if (vis.perm === "own") continue;
    for (const f of vis.withheld) {
      const id = CHECK_OF[f];
      if (!id) continue;
      if (id === "certificates" && demand.data.must_have_certificates.length === 0) continue;
      if (id === "available_date" && demand.data.need_by === null) continue;
      const c = a.checks.find((x) => x.id === id);
      if (c && (c.status !== "unknown" || c.detail !== WITHHELD_DETAIL)) fail("withheld_field_used", `${a.id}: ${f} withheld but ${id} is ${c.status} (${c.detail})`);
    }
    const hit = leaked(JSON.stringify([a.checks, a.score]), lot.id, vis.withheld);
    if (hit.length) fail("withheld_value_in_assessment", `${a.id}: ${hit.join(", ")}`);
  }

  // Opportunities against the expected pairs.
  const open = opps.filter((o) => o.status !== "invalidated");
  const openByPair = new Map<string, typeof open>();
  for (const o of open) {
    const k = `${o.demand_id}|${o.lot_id}`;
    openByPair.set(k, [...(openByPair.get(k) ?? []), o]);
  }
  const byStatus: Record<string, number> = {};
  let reviewableOpen = 0;
  for (const [k, list] of openByPair) {
    if (list.length > 1) fail("duplicate_open_opportunity", `${k}: ${list.length} open`);
    const cur = current.get(k);
    for (const o of list) {
      if (!cur) {
        fail("unauthorized_opportunity", `${o.id}: ${k} is not visible to ${o.buyer_network_id} now`);
        continue;
      }
      if (o.assessment_id !== cur.a.id) fail("outdated_open_opportunity", `${o.id}: on ${o.assessment_id}, current is ${cur.a.id}`);
    }
  }
  for (const [k, { a, vis, lot, demand }] of current) {
    byStatus[a.compatibility_status] = (byStatus[a.compatibility_status] ?? 0) + 1;
    const hasOpen = openByPair.has(k);
    if (a.compatibility_status === "incompatible") {
      if (hasOpen) fail("incompatible_open_opportunity", k);
    } else if (!hasOpen) fail("missing_opportunity", `${k} (${a.compatibility_status})`);

    const o = oracle(lot.data, demand.data, vis.withheld, now);
    const engineReviewable = REVIEWABLE.includes(a.compatibility_status);
    if (engineReviewable) reviewableOpen++;
    if (engineReviewable && !o.reviewable) fail("hard_constraint_violation", `${k}: ${a.compatibility_status} but ${o.reasons.join(", ")}`);
    if (!engineReviewable && o.reviewable) {
      const why = a.checks.filter((c) => c.status !== "pass" && c.status !== "not_checked").map((c) => `${c.id}=${c.status}`);
      fail("missed_clean_match", `${k}: ${a.compatibility_status} (${why.join(", ")})`);
    }
    if (a.compatibility_status === "engineering_review_required" && !o.gradeMismatch) fail("unexpected_engineering_review", k);
  }

  // What the buyer's pages return: the list for every network, details for a sample.
  let views = 0;
  const nameOf = new Map(world.networks.map((n) => [n.id, n.name]));
  for (const n of world.networks) {
    const actor: Actor = { id: `u-${n.id.slice(4)}`, network_id: n.id, role: "trader" };
    const list = await listOpportunitiesForActor(db, actor, now);
    // The list never carries lot values or seller names, so any canary or private name is a leak.
    const listJson = JSON.stringify(list);
    for (const m of listJson.match(CANARY) ?? []) fail("leak_in_list", `${n.id} sees ${m}`);
    for (const other of world.networks) {
      if (other.id !== n.id && listJson.includes(other.name)) fail("leak_in_list", `${n.id} sees the private name of ${other.id}`);
    }

    const cross = list.filter((o) => o.novelty === "cross_network");
    const sample = [...cross.filter((o) => o.status !== "invalidated").slice(0, opts.viewsPerNetwork), ...cross.filter((o) => o.status === "invalidated").slice(0, opts.viewsPerNetwork)];
    for (const o of sample) {
      const view = await getOpportunityForActor(db, actor, o.id, now);
      views++;
      const json = JSON.stringify(view);
      const lot = lotById.get(o.lot_id)!;
      const vis = visibility(n.id, lot);
      const a = assessmentById.get(o.assessment_id)!;
      const accessNow = vis !== null && vis.perm === a.permission_version && o.status !== "invalidated";
      if (!accessNow) {
        // Access ended or the opportunity was superseded: no lot values at all.
        const hit = Object.values(world.canaries[o.lot_id] ?? {}).filter((s) => json.includes(s));
        if (view.lot !== null || view.score !== null || hit.length) fail("detail_after_access_ended", `${o.id}: lot ${view.lot ? "shown" : "hidden"}, ${hit.length} canary value(s)`);
        continue;
      }
      const hit = leaked(json, o.lot_id, vis.withheld);
      if (hit.length) fail("leak_in_detail", `${o.id}: ${hit.join(", ")}`);
      if (!vis.disclosed && json.includes(nameOf.get(lot.owner_network_id)!)) fail("leak_in_detail", `${o.id}: private seller name`);
    }
  }

  return { expected_pairs: expected, open_opportunities: open.length, reviewable_open: reviewableOpen, by_status: byStatus, failures, examples, views_checked: views };
}

export const failureCount = (r: ScaleReport) => Object.values(r.failures).reduce((a, b) => a + b, 0);
