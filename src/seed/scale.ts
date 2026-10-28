import { createHash } from "node:crypto";
import type { Db } from "@/db/client";
import { insertDemand, insertGrant, insertLot } from "@/db/repo";
import { HRC_SCHEMA_VERSION, InventoryLotFields, type Demand, type InventoryLot, type InventoryLotField } from "@/domain/hrc";

// Large synthetic world for scale tests (beyond plan §12.1 MVP size). Generated from a fixed
// seed, entirely fictional, and loaded straight into the tables: the volume
// test is about discovery, authorization and invalidation, not extraction, so
// it needs no documents and makes no model calls.
//
// About half the lots are built from some network's demand, so matches and
// near misses are common; most of those carry one planted deviation (out of
// range, other grade, missing certificate, ...). Free-text fields hold unique
// canary strings, so a withheld value showing up anywhere is detectable.

export interface ScaleConfig {
  seed: number;
  networks: number;
  lotsPerNetwork: number;
  demandsPerNetwork: number;
}

export const SCALE_PRESETS = {
  test: { seed: 7, networks: 4, lotsPerNetwork: 40, demandsPerNetwork: 3 },
  s: { seed: 20261101, networks: 5, lotsPerNetwork: 100, demandsPerNetwork: 4 },
  m: { seed: 20261102, networks: 8, lotsPerNetwork: 250, demandsPerNetwork: 8 },
  l: { seed: 20261103, networks: 12, lotsPerNetwork: 500, demandsPerNetwork: 12 },
} satisfies Record<string, ScaleConfig>;

export interface ScaleGrant {
  id: string;
  owner_network_id: string;
  recipient_network_id: string;
  lot_id: string | null;
  field_scope: InventoryLotField[];
  allow_discovery: boolean;
  allow_identity_disclosure: boolean;
  expires_at: string | null;
  revoked: boolean;
}

export interface ScaleWorld {
  config: ScaleConfig;
  now: string;
  networks: { id: string; name: string; alias: string }[];
  users: { id: string; network_id: string }[];
  lots: InventoryLot[];
  demands: Demand[];
  grants: ScaleGrant[];
  /** Unique strings planted in each lot's free-text fields. */
  canaries: Record<string, Partial<Record<InventoryLotField, string>>>;
}

export const ALL_FIELDS = Object.keys(InventoryLotFields.shape) as InventoryLotField[];

const GRADES = [
  { grade: "SS400", standard_id: "JIS G3101" },
  { grade: "Q235B", standard_id: "GB/T 700" },
  { grade: "S235JR", standard_id: "EN 10025-2" },
  { grade: "SS275", standard_id: "KS D3503" },
  { grade: "A36", standard_id: "ASTM A36" },
  { grade: "Q355B", standard_id: "GB/T 1591" },
];
const THICKNESS = [1.6, 2, 2.3, 2.5, 2.75, 3, 3.2, 4, 4.5, 5, 6, 8];
const WIDTH = [1000, 1219, 1250, 1500, 1524, 1800, 2000];
const PORTS = ["Haiphong", "Busan", "Ho Chi Minh City", "Laem Chabang", "Port Klang", "Jakarta", "Manila", "Tianjin"];
const CERT_SETS = [[], ["MTC"], ["MTC"], ["MTC", "EN 10204 3.1"]];
const DEVIATIONS = [
  "thickness_out",
  "width_out",
  "other_grade",
  "other_standard",
  "secondary_no_notes",
  "secondary_with_notes",
  "below_min",
  "above_max_single",
  "above_max_splittable",
  "missing_cert",
  "late",
  "plate",
  "unknown_width",
  "implausible_thickness",
] as const;

/** Field scopes for network-wide grants: everything, matching fields only, or one matching field withheld. */
const PRIVATE_FIELDS: InventoryLotField[] = ["seller_lot_ref", "heat_numbers", "location_place", "defect_notes", "price_amount", "price_currency", "incoterm_place"];
const MATCH_FIELD_WITHHELD: InventoryLotField[] = ["thickness_mm", "certificate_claims", "available_from", "grade_raw", "total_kg"];

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    hex: (n: number) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join(""),
  };
}

type Fields = InventoryLot["fields"];
type Obs = Fields[keyof Fields];

function obs(value: unknown, sourceStated: boolean, issues: string[] = []): Obs {
  if (value === null) {
    return { raw_value: null, normalized_value: null, unit: null, status: "not_stated", evidence: [], normalization: null, issues, review: { status: "pending", reviewer_id: null } } as Obs;
  }
  return {
    raw_value: String(value),
    normalized_value: value,
    unit: null,
    status: sourceStated ? "source_stated" : "user_confirmed",
    evidence: [{ source_id: "scale", fragment_id: "L1", locator: { kind: "text_span", start: 0, end: 1 }, quote: String(value) }],
    normalization: null,
    issues,
    review: { status: sourceStated ? "pending" : "confirmed", reviewer_id: null },
  } as Obs;
}

const addDays = (iso: string, days: number) => new Date(new Date(iso).getTime() + days * 86_400_000).toISOString().slice(0, 10);
const hoursBefore = (iso: string, h: number) => new Date(new Date(iso).getTime() - h * 3_600_000).toISOString();

export function generateScale(config: ScaleConfig, now = "2026-11-01T00:00:00.000Z"): ScaleWorld {
  const r = rng(config.seed);
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const networks = Array.from({ length: config.networks }, (_, i) => ({
    id: `net-s${pad(i + 1, 2)}`,
    name: `Private Trader ${r.hex(8)}`,
    alias: `Network S${pad(i + 1, 2)}`,
  }));
  const users = networks.map((n) => ({ id: `u-${n.id.slice(4)}`, network_id: n.id }));

  const demands: Demand[] = [];
  for (const n of networks) {
    for (let j = 1; j <= config.demandsPerNetwork; j++) {
      const g = r.pick(GRADES);
      const extra = r.chance(0.3) ? [r.pick(GRADES.filter((x) => x !== g))] : [];
      const t = r.pick(THICKNESS);
      const w = r.pick(WIDTH);
      const tTol = r.pick([0.05, 0.1, 0.15]);
      const minKg = r.int(8, 40) * 1000;
      const maxKg = minKg + r.int(2, 15) * 1000;
      const port = r.pick(PORTS);
      demands.push({
        schema_version: HRC_SCHEMA_VERSION,
        demand_id: `dem-${n.id.slice(4)}-${pad(j, 2)}`,
        version: 1,
        buyer_network_id: n.id,
        title: `HRC ${g.grade} ${t} × ${w} for ${port}`,
        product_form: "hot_rolled_coil",
        quantity_kg: { min: minKg, target: Math.round((minKg + maxKg) / 2), max: maxKg },
        // A few demands leave one side of the thickness range open.
        thickness_mm: { min: r.chance(0.05) ? null : Math.round((t - tTol) * 100) / 100, max: Math.round((t + tTol) * 100) / 100, source: "buyer_explicit" },
        width_mm: { min: w - 5, max: w + 5, source: "buyer_explicit" },
        accepted_grades: [g, ...extra].map((x) => ({ grade: x.grade, standard_id: r.chance(0.85) ? x.standard_id : null, edition: null })),
        substitution_policy: r.chance(0.5) ? "forbidden" : "review_required",
        acceptable_conditions: r.chance(0.7) ? ["prime"] : ["prime", "secondary"],
        must_have_certificates: r.pick(CERT_SETS),
        allow_partial_delivery: r.chance(0.3),
        allow_multi_lot: false,
        destination: port,
        need_by: r.chance(0.85) ? addDays(now, r.int(5, 40)) : null,
        budget: r.chance(0.7) ? { amount: String(r.int(500, 620)), currency: "USD", basis: "per_mt", incoterm: "CFR", place: port } : null,
        expires_at: r.chance(0.05) ? hoursBefore(now, 24) : null,
        synthetic: true,
      });
    }
  }

  const lots: InventoryLot[] = [];
  const canaries: ScaleWorld["canaries"] = {};
  for (const n of networks) {
    for (let i = 1; i <= config.lotsPerNetwork; i++) {
      const lotId = `lot-${n.id.slice(4)}-${pad(i, 4)}`;
      const base = r.chance(0.5) ? r.pick(demands) : null;
      const deviation = base && r.chance(0.6) ? r.pick(DEVIATIONS) : null;
      const sourceStated = r.chance(0.3);

      let grade = base ? r.pick(base.accepted_grades) : r.pick(GRADES);
      let standard = base ? (grade.standard_id ?? GRADES.find((x) => x.grade === grade.grade)!.standard_id) : (grade as { standard_id: string }).standard_id;
      let form = "hot_rolled_coil";
      let thickness: number | null = base ? (base.thickness_mm.max! + (base.thickness_mm.min ?? base.thickness_mm.max!)) / 2 : r.pick(THICKNESS);
      let width: number | null = base ? (base.width_mm.min! + base.width_mm.max!) / 2 : r.pick(WIDTH);
      let kg = base ? r.int(base.quantity_kg.min / 1000, base.quantity_kg.max / 1000) * 1000 : r.int(5, 60) * 1000;
      let pieces = r.int(1, 6);
      let splittable: boolean | null = r.pick([true, false, null]);
      let condition = r.chance(0.85) ? "prime" : "secondary";
      let certs: string[] = base ? [...base.must_have_certificates] : r.pick(CERT_SETS);
      let available = base?.need_by ? addDays(base.need_by, -r.int(1, 4)) : addDays(now, r.int(0, 30));
      const thicknessIssues: string[] = [];
      const notes = `defects ${r.hex(10)}`;
      let hasNotes = condition === "secondary" && r.chance(0.7);

      switch (deviation) {
        case "thickness_out":
          thickness = base!.thickness_mm.max! + 0.5;
          break;
        case "width_out":
          width = base!.width_mm.max! + 200;
          break;
        case "other_grade": {
          const other = GRADES.filter((x) => !base!.accepted_grades.some((a) => a.grade === x.grade));
          grade = r.pick(other);
          standard = (grade as { standard_id: string }).standard_id;
          break;
        }
        case "other_standard":
          standard = "ISO 0000";
          break;
        case "secondary_no_notes":
          condition = "secondary";
          hasNotes = false;
          break;
        case "secondary_with_notes":
          condition = "secondary";
          hasNotes = true;
          break;
        case "below_min":
          kg = base!.quantity_kg.min - 3000;
          break;
        case "above_max_single":
          kg = base!.quantity_kg.max + 5000;
          pieces = 1;
          break;
        case "above_max_splittable":
          kg = base!.quantity_kg.max + 5000;
          pieces = 3;
          splittable = true;
          break;
        case "missing_cert":
          certs = [];
          break;
        case "late":
          available = base!.need_by ? addDays(base!.need_by, 5) : available;
          break;
        case "plate":
          form = "hot_rolled_plate";
          break;
        case "unknown_width":
          width = null;
          break;
        case "implausible_thickness":
          thickness = thickness! * 10;
          thicknessIssues.push("implausible_thickness");
          break;
      }

      const c = {
        seller_lot_ref: `SL-${r.hex(12)}`,
        heat_numbers: `HT-${r.hex(12)}`,
        location_place: `Yard ${r.hex(12)}`,
        ...(hasNotes ? { defect_notes: notes } : {}),
      };
      canaries[lotId] = c;
      const port = base?.destination ?? r.pick(PORTS);
      const v: Record<InventoryLotField, unknown> = {
        seller_lot_ref: c.seller_lot_ref,
        product_form: form,
        grade_raw: grade.grade,
        standard_id: standard,
        standard_edition: null,
        certificate_claims: certs,
        heat_numbers: [c.heat_numbers],
        thickness_mm: thickness === null ? null : Math.round(thickness * 1000) / 1000,
        width_mm: width,
        total_kg: kg,
        piece_count: pieces,
        splittable,
        location_country: null,
        location_place: c.location_place,
        available_from: available,
        price_amount: String(r.int(480, 640)),
        price_currency: "USD",
        price_basis: "per_mt",
        incoterm: "CFR",
        incoterm_place: port,
        condition,
        defect_notes: hasNotes ? notes : null,
        surplus_reason: r.pick(["partial_shipment_remainder", "slitting_remainder", "cancelled_lc", "other"]),
      };
      const roll = r.next();
      const status = roll < 0.85 ? "published" : roll < 0.9 ? "sold" : roll < 0.94 ? "withdrawn" : "needs_review";
      const verifiedH = r.chance(0.85) ? r.int(0, 40) : r.int(50, 200);
      lots.push({
        schema_version: HRC_SCHEMA_VERSION,
        lot_id: lotId,
        version: 1,
        owner_network_id: n.id,
        status,
        fields: Object.fromEntries(ALL_FIELDS.map((f) => [f, obs(v[f], sourceStated, f === "thickness_mm" ? thicknessIssues : [])])) as Fields,
        source_ids: ["scale"],
        extraction_run_id: null,
        observed_at: hoursBefore(now, verifiedH + 1),
        last_verified_at: hoursBefore(now, verifiedH),
        synthetic: true,
      });
    }
  }

  // Grants. Ids increase in creation order, matching the engine's "newest grant wins".
  const grants: ScaleGrant[] = [];
  const grantId = () => `grant-s-${pad(grants.length + 1, 5)}`;
  const flags = () => ({
    allow_discovery: !r.chance(0.05),
    allow_identity_disclosure: r.chance(0.2),
    expires_at: r.chance(0.05) ? hoursBefore(now, 2) : r.chance(0.1) ? addDays(now, 30) + "T00:00:00.000Z" : null,
    revoked: r.chance(0.05),
  });
  for (const owner of networks) {
    for (const recipient of networks) {
      if (owner === recipient || !r.chance(0.6)) continue;
      const roll = r.next();
      const field_scope =
        roll < 0.4 ? ALL_FIELDS : roll < 0.8 ? ALL_FIELDS.filter((f) => !PRIVATE_FIELDS.includes(f)) : ALL_FIELDS.filter((f) => f !== r.pick(MATCH_FIELD_WITHHELD));
      grants.push({ id: grantId(), owner_network_id: owner.id, recipient_network_id: recipient.id, lot_id: null, field_scope, ...flags() });
    }
  }
  // Single-lot grants, made after the network-wide ones, so they take precedence where both apply.
  for (const lot of lots) {
    if (!r.chance(0.08)) continue;
    const recipient = r.pick(networks.filter((n) => n.id !== lot.owner_network_id));
    grants.push({ id: grantId(), owner_network_id: lot.owner_network_id, recipient_network_id: recipient.id, lot_id: lot.lot_id, field_scope: ALL_FIELDS, ...flags() });
  }

  return { config, now, networks, users, lots, demands, grants, canaries };
}

/** Stable fingerprint of a generated world (determinism check). */
export const worldHash = (w: ScaleWorld) => createHash("sha256").update(JSON.stringify(w)).digest("hex").slice(0, 16);

/** Bulk load in one transaction. Revoked grants are revoked before any discovery runs. */
export async function loadScale(db: Db, w: ScaleWorld) {
  await db.transaction(async (tx) => {
    for (const n of w.networks) await tx.query(`INSERT INTO networks (id, name, alias, region, synthetic) VALUES ($1,$2,$3,'Scale test',true)`, [n.id, n.name, n.alias]);
    for (const u of w.users) await tx.query(`INSERT INTO users (id, network_id, name, role, synthetic) VALUES ($1,$2,$3,'trader',true)`, [u.id, u.network_id, `Trader ${u.network_id}`]);
    for (const lot of w.lots) await insertLot(tx, lot, null, `u-${lot.owner_network_id.slice(4)}`);
    for (const d of w.demands) await insertDemand(tx, d, `u-${d.buyer_network_id.slice(4)}`);
    for (const g of w.grants) {
      await insertGrant(
        tx,
        {
          owner_network_id: g.owner_network_id,
          recipient_network_id: g.recipient_network_id,
          lot_id: g.lot_id,
          field_scope: g.field_scope,
          allow_discovery: g.allow_discovery,
          allow_model_processing: false,
          allow_identity_disclosure: g.allow_identity_disclosure,
          expires_at: g.expires_at === null ? null : new Date(g.expires_at),
          created_by: `u-${g.owner_network_id.slice(4)}`,
        },
        g.id,
      );
      if (g.revoked) await tx.query(`UPDATE sharing_grants SET revoked_at = $2 WHERE id = $1`, [g.id, hoursBefore(w.now, 1)]);
    }
  });
}
