import { createHash } from "node:crypto";
import type { Sql } from "@/db/client";
import {
  audit,
  getDemand,
  getLot,
  newId,
  sharedLotsFor,
  type DemandWithData,
  type LotWithData,
  type OpportunityRow,
} from "@/db/repo";
import { InventoryLotFields, type InventoryLot, type InventoryLotField } from "@/domain/hrc";
import { evaluateConstraints, FRESHNESS_WINDOW_HOURS, isFresh, RULES_VERSION, type AccessContext, type CompatibilityStatus } from "./constraints";
import { scoreCandidate } from "./score";

// Discovery (plan §12.1). Runs when a lot or demand changes, or on demand.
// The universe is built from authorized rows *before* any matching, so a lot
// the buyer's network may not see is never evaluated, scored or explained.

const ALL_FIELDS = Object.keys(InventoryLotFields.shape) as InventoryLotField[];

export interface VisibleLot {
  lot: LotWithData;
  access: AccessContext;
  permission_version: string;
}

/** Published lots a network may use in discovery: its own, plus shared ones. `lotId` narrows to one lot. */
export async function visibleLots(sql: Sql, networkId: string, now: Date, lotId: string | null = null): Promise<VisibleLot[]> {
  const own = await sql.query<LotWithData>(
    `SELECT l.*, v.data FROM lots l JOIN lot_versions v ON v.lot_id = l.id AND v.version = l.current_version
      WHERE l.owner_network_id = $1 AND l.status = 'published' AND ($2::text IS NULL OR l.id = $2)`,
    [networkId, lotId],
  );
  const out: VisibleLot[] = own.map((lot) => ({ lot, access: { own: true, grant_id: null, withheld: [] }, permission_version: "own" }));
  const seen = new Set<string>();
  for (const row of await sharedLotsFor(sql, networkId, now, lotId)) {
    if (seen.has(row.id)) continue; // newest grant wins when several cover one lot
    seen.add(row.id);
    const scope = new Set(row.field_scope);
    const lot: LotWithData = {
      id: row.id,
      owner_network_id: row.owner_network_id,
      current_version: row.current_version,
      status: row.status,
      source_document_id: row.source_document_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      data: row.data,
    };
    out.push({
      lot,
      access: { own: false, grant_id: row.grant_id, withheld: ALL_FIELDS.filter((f) => !scope.has(f)) },
      permission_version: `grant:${row.grant_id}`,
    });
  }
  return out;
}

const assessmentId = (parts: (string | number)[]) => `asm_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16)}`;

export interface DiscoveryStats {
  pairs: number;
  reviewable: number;
  needs_evidence: number;
  engineering_review: number;
  rejected: number;
  new_opportunities: number;
  invalidated: number;
}

const emptyStats = (): DiscoveryStats => ({ pairs: 0, reviewable: 0, needs_evidence: 0, engineering_review: 0, rejected: 0, new_opportunities: 0, invalidated: 0 });

function count(stats: DiscoveryStats, status: CompatibilityStatus) {
  stats.pairs++;
  if (status === "incompatible") stats.rejected++;
  else if (status === "insufficient_evidence") stats.needs_evidence++;
  else if (status === "engineering_review_required") stats.engineering_review++;
  else stats.reviewable++;
}

/**
 * What is already stored for one buyer network. Assessments are immutable and
 * their ID covers everything the result depends on, so a pair whose
 * assessment exists and whose opportunity is already in the right state needs
 * no re-evaluation and no write.
 */
interface Stored {
  assessments: Map<string, CompatibilityStatus>;
  openByPair: Map<string, string[]>;
}

async function loadStored(sql: Sql, networkId: string): Promise<Stored> {
  const assessments = await sql.query<{ id: string; compatibility_status: CompatibilityStatus }>(
    `SELECT a.id, a.compatibility_status FROM match_assessments a JOIN demands d ON d.id = a.demand_id WHERE d.buyer_network_id = $1`,
    [networkId],
  );
  const opps = await sql.query<{ demand_id: string; lot_id: string; assessment_id: string; status: string }>(
    `SELECT demand_id, lot_id, assessment_id, status FROM opportunities WHERE buyer_network_id = $1 AND status <> 'invalidated'`,
    [networkId],
  );
  const openByPair = new Map<string, string[]>();
  for (const o of opps) {
    const k = `${o.demand_id}|${o.lot_id}`;
    openByPair.set(k, [...(openByPair.get(k) ?? []), o.assessment_id]);
  }
  return {
    assessments: new Map(assessments.map((a) => [a.id, a.compatibility_status])),
    openByPair,
  };
}

async function assessPair(sql: Sql, demand: DemandWithData, v: VisibleLot, now: Date, stats: DiscoveryStats, stored?: Stored) {
  const lot = v.lot;
  // Freshness depends on time, so it is part of the assessment identity:
  // when stock goes stale a new assessment is made instead of rewriting the
  // old one, and decisions taken on the old one do not carry over.
  const freshness = isFresh(lot.data, now) ? "fresh" : "stale";
  const id = assessmentId([lot.id, lot.current_version, demand.id, demand.current_version, v.permission_version, RULES_VERSION, freshness]);

  // Unchanged pair: the full path below would write nothing.
  const known = stored?.assessments.get(id);
  if (known !== undefined) {
    const open = stored!.openByPair.get(`${demand.id}|${lot.id}`) ?? [];
    // No open opportunity is only settled for an incompatible pair; otherwise one is (re)created below.
    const settled = open.length === 0 ? known === "incompatible" : open.length === 1 && open[0] === id;
    if (settled) {
      count(stats, known);
      return;
    }
  }

  // Matching only ever sees the projection the owner shared with this network.
  const shared = projectLot(lot.data, v.access);
  const result = evaluateConstraints(shared, demand.data, v.access, now);
  const score = scoreCandidate(shared, demand.data, now);
  const status = result.compatibility_status;
  count(stats, status);

  await sql.query(
    `INSERT INTO match_assessments (id, lot_id, lot_version, demand_id, demand_version, permission_version, rules_version, freshness, compatibility_status, checks, score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO NOTHING`,
    [id, lot.id, lot.current_version, demand.id, demand.current_version, v.permission_version, RULES_VERSION, freshness, status, JSON.stringify(result.checks), score],
  );

  const open = await sql.query<OpportunityRow>(
    `SELECT * FROM opportunities WHERE demand_id = $1 AND lot_id = $2 AND status <> 'invalidated'`,
    [demand.id, lot.id],
  );
  for (const o of open) {
    if (o.assessment_id === id) continue;
    await invalidate(sql, o.id, "Superseded: lot, demand or sharing changed and the pair was re-assessed");
    stats.invalidated++;
  }
  const current = open.find((o) => o.assessment_id === id);
  if (status === "incompatible") {
    if (current) {
      await invalidate(sql, current.id, "Re-assessment found a hard-constraint failure");
      stats.invalidated++;
    }
    return;
  }
  if (current) return; // assessments are immutable, so nothing to update
  const oppId = newId("opp");
  const inserted = await sql.query(
    `INSERT INTO opportunities (id, assessment_id, demand_id, lot_id, buyer_network_id, seller_network_id, novelty, compatibility_status, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'discovered')
     ON CONFLICT (assessment_id) WHERE status <> 'invalidated' DO NOTHING RETURNING id`,
    [oppId, id, demand.id, lot.id, demand.buyer_network_id, lot.owner_network_id, v.access.own ? "same_network" : "cross_network", status],
  );
  if (inserted.length === 0) return;
  await audit(sql, null, "opportunity.discovered", "opportunity", oppId, { assessment: id, status });
  stats.new_opportunities++;
}

async function invalidate(sql: Sql, oppId: string, reason: string) {
  await sql.query(`UPDATE opportunities SET status = 'invalidated', invalidated_reason = $2, updated_at = now() WHERE id = $1`, [oppId, reason]);
  await audit(sql, null, "opportunity.invalidated", "opportunity", oppId, { reason });
}

const PRIVATE_REF = {
  source_id: "owner_private",
  fragment_id: "owner_private",
  locator: { kind: "owner_private" as const },
  quote: "",
};

/**
 * The shared-listing projection another network works with (plan §8.3).
 * Fields outside the grant scope become Unknown. Shared fields keep their
 * value, unit, status and issue codes, but no raw text, quotes, locations,
 * source IDs or reviewer identity: those come from the owner's private
 * documents and could carry withheld facts.
 */
export function projectLot(data: InventoryLot, access: AccessContext): InventoryLot {
  if (access.own) return data;
  const withheld = new Set(access.withheld);
  const fields = {} as Record<InventoryLotField, InventoryLot["fields"][InventoryLotField]>;
  for (const f of ALL_FIELDS) {
    const o = data.fields[f];
    fields[f] = withheld.has(f)
      ? {
          raw_value: null,
          normalized_value: null,
          unit: null,
          status: "not_stated",
          evidence: [],
          normalization: null,
          issues: ["withheld_by_owner"],
          review: { status: "pending", reviewer_id: null },
        }
      : {
          ...o,
          raw_value: null,
          evidence: o.evidence.length ? [PRIVATE_REF] : [],
          issues: o.issues.map((i) => i.split(":")[0]),
          review: { status: o.review.status, reviewer_id: null },
        };
  }
  return { ...data, fields: fields as InventoryLot["fields"], source_ids: ["owner_private"], extraction_run_id: null };
}

const activeDemands = (sql: Sql, where: string, params: unknown[]) =>
  sql.query<DemandWithData>(
    `SELECT d.*, v.data FROM demands d JOIN demand_versions v ON v.demand_id = d.id AND v.version = d.current_version
      WHERE d.status = 'active' AND ${where}`,
    params,
  );

const isExpired = (d: DemandWithData, now: Date) => d.data.expires_at !== null && new Date(d.data.expires_at) <= now;

/** New or changed lot: match it against every active demand that may see it. */
export async function discoverForLot(sql: Sql, lotId: string, now: Date): Promise<DiscoveryStats> {
  const stats = emptyStats();
  stats.invalidated += await invalidateStale(sql, now);
  const lot = await getLot(sql, lotId);
  if (!lot || lot.status !== "published") return stats;
  const seen = new Map<string, VisibleLot | null>();
  for (const demand of await activeDemands(sql, "true", [])) {
    if (isExpired(demand, now)) continue;
    if (!seen.has(demand.buyer_network_id)) seen.set(demand.buyer_network_id, (await visibleLots(sql, demand.buyer_network_id, now, lotId))[0] ?? null);
    const v = seen.get(demand.buyer_network_id);
    if (v) await assessPair(sql, demand, v, now, stats);
  }
  return stats;
}

/** New or changed demand: match it against every lot its network may see. */
export async function discoverForDemand(sql: Sql, demandId: string, now: Date): Promise<DiscoveryStats> {
  const stats = emptyStats();
  stats.invalidated += await invalidateStale(sql, now);
  const demand = await getDemand(sql, demandId);
  if (!demand || demand.status !== "active" || isExpired(demand, now)) return stats;
  const stored = await loadStored(sql, demand.buyer_network_id);
  for (const v of await visibleLots(sql, demand.buyer_network_id, now)) await assessPair(sql, demand, v, now, stats, stored);
  return stats;
}

/** Full re-run over all authorized pairs (manual "re-run discovery"). */
export async function discoverAll(sql: Sql, now: Date, networkId?: string): Promise<DiscoveryStats> {
  const stats = emptyStats();
  stats.invalidated += await invalidateStale(sql, now);
  const demands = networkId ? await activeDemands(sql, "d.buyer_network_id = $1", [networkId]) : await activeDemands(sql, "true", []);
  const cache = new Map<string, { lots: VisibleLot[]; stored: Stored }>();
  for (const demand of demands) {
    if (isExpired(demand, now)) continue;
    const net = demand.buyer_network_id;
    if (!cache.has(net)) cache.set(net, { lots: await visibleLots(sql, net, now), stored: await loadStored(sql, net) });
    const { lots, stored } = cache.get(net)!;
    for (const v of lots) await assessPair(sql, demand, v, now, stats, stored);
  }
  return stats;
}

/**
 * Invalidates opportunities whose lot, demand or authorization no longer
 * matches the assessed versions (plan §9.5 rules 8–9). Sold, withdrawn or
 * revoked means the buyer can no longer act on — or view — the candidate.
 */
export async function invalidateStale(sql: Sql, now: Date): Promise<number> {
  const rows = await sql.query<{
    id: string;
    reason: string | null;
  }>(
    `SELECT o.id,
            CASE
              WHEN l.status <> 'published' THEN 'Lot is ' || l.status
              WHEN l.current_version <> a.lot_version THEN 'Lot changed (v' || a.lot_version || ' → v' || l.current_version || ')'
              WHEN d.status <> 'active' THEN 'Demand is ' || d.status
              WHEN (dv.data->>'expires_at') IS NOT NULL AND (dv.data->>'expires_at')::timestamptz <= $1 THEN 'Demand expired'
              WHEN a.freshness = 'fresh' AND COALESCE(lv.data->>'last_verified_at', lv.data->>'observed_at')::timestamptz < $1::timestamptz - make_interval(hours => $2)
                THEN 'Stock confirmation is older than ' || $2 || ' h; ask the seller to reconfirm' 
              WHEN d.current_version <> a.demand_version THEN 'Demand changed (v' || a.demand_version || ' → v' || d.current_version || ')'
              WHEN a.permission_version LIKE 'grant:%' AND NOT EXISTS (
                SELECT 1 FROM sharing_grants g
                 WHERE 'grant:' || g.id = a.permission_version
                   AND g.revoked_at IS NULL AND g.allow_discovery
                   AND (g.expires_at IS NULL OR g.expires_at > $1)
              ) THEN 'Sharing was revoked or expired'
              ELSE NULL
            END AS reason
       FROM opportunities o
       JOIN match_assessments a ON a.id = o.assessment_id
       JOIN lots l ON l.id = o.lot_id
       JOIN demands d ON d.id = o.demand_id
       JOIN demand_versions dv ON dv.demand_id = d.id AND dv.version = d.current_version
       JOIN lot_versions lv ON lv.lot_id = a.lot_id AND lv.version = a.lot_version
      WHERE o.status <> 'invalidated'`,
    [now, FRESHNESS_WINDOW_HOURS],
  );
  let n = 0;
  for (const r of rows) {
    if (r.reason === null) continue;
    await invalidate(sql, r.id, r.reason);
    n++;
  }
  return n;
}

export const GROUP_ORDER: CompatibilityStatus[] = [
  "evidence_supported",
  "declared_match",
  "conditional_candidate",
  "engineering_review_required",
  "insufficient_evidence",
];
