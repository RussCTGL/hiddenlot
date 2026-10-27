import type { Sql } from "@/db/client";
import {
  getDemand,
  getDemandVersion,
  getLot,
  getLotVersion,
  type DocumentRow,
  type FragmentRow,
  type OpportunityRow,
  type UserRow,
} from "@/db/repo";
import type { Check, CompatibilityStatus } from "@/discovery/constraints";
import { discoverAll, projectLot, visibleLots } from "@/discovery/engine";
import type { Score } from "@/discovery/score";
import type { Demand, InventoryLot } from "@/domain/hrc";

// Server-side authorization (plan §8.3, §15.2). Nothing is fetched for one
// network and then hidden in the UI: every function here checks the actor's
// network and the live grant before returning data, on every call.

export class ForbiddenError extends Error {
  constructor(message = "Not authorized") {
    super(message);
  }
}
export class NotFoundError extends Error {}

export type Actor = Pick<UserRow, "id" | "network_id" | "role">;

/** Raw source documents never leave the owner network, whatever is shared. */
export async function getDocumentForActor(sql: Sql, actor: Actor, documentId: string) {
  const doc = (await sql.query<DocumentRow>(`SELECT id, network_id, kind, filename, mime, size_bytes, sha256, parser_version, status, error, synthetic, created_by, created_at FROM source_documents WHERE id = $1`, [documentId]))[0];
  // Same response for "missing" and "someone else's", so IDs cannot be probed.
  if (!doc || doc.network_id !== actor.network_id) throw new NotFoundError("Document not found");
  const fragments = await sql.query<FragmentRow>(`SELECT * FROM source_fragments WHERE document_id = $1 ORDER BY seq`, [documentId]);
  return { doc, fragments };
}

export async function getDocumentContentForActor(sql: Sql, actor: Actor, documentId: string) {
  const rows = await sql.query<{ network_id: string; content: Uint8Array; mime: string | null; filename: string | null }>(
    `SELECT network_id, content, mime, filename FROM source_documents WHERE id = $1`,
    [documentId],
  );
  if (!rows[0] || rows[0].network_id !== actor.network_id) throw new NotFoundError("Document not found");
  return rows[0];
}

export async function getOwnLot(sql: Sql, actor: Actor, lotId: string) {
  const lot = await getLot(sql, lotId);
  if (!lot || lot.owner_network_id !== actor.network_id) throw new NotFoundError("Lot not found");
  return lot;
}

export async function getOwnDemand(sql: Sql, actor: Actor, demandId: string) {
  const d = await getDemand(sql, demandId);
  if (!d || d.buyer_network_id !== actor.network_id) throw new NotFoundError("Demand not found");
  return d;
}

export interface OpportunityView {
  opportunity: OpportunityRow;
  demand: Demand;
  /** The lot as this network may see it now: projected to the live grant scope. Null once access ended. */
  lot: InventoryLot | null;
  seller_label: string;
  checks: Check[];
  /** Null once access ended: the score was computed from lot values. */
  score: Score | null;
  compatibility_status: CompatibilityStatus;
  access_note: string | null;
  /** Own lots, or the owner's grant allows sending shared fields to the model. */
  model_processing_allowed: boolean;
}

interface AssessmentRow {
  id: string;
  lot_id: string;
  lot_version: number;
  demand_id: string;
  demand_version: number;
  permission_version: string;
  rules_version: string;
  compatibility_status: CompatibilityStatus;
  checks: Check[];
  score: Score;
  created_at: Date;
}

/**
 * Time-based rules (grant or demand expiry, stock freshness) have no event, so
 * every read first re-evaluates the actor's network. Data is small enough
 * (plan §12.1) that this costs milliseconds.
 */
export async function refreshForActor(sql: Sql, actor: Actor, now: Date) {
  await discoverAll(sql, now, actor.network_id);
}

export async function listOpportunitiesForActor(sql: Sql, actor: Actor, now: Date) {
  await refreshForActor(sql, actor, now);
  // Lot values are not read here: the list shows only the assessment, which was
  // computed on the projection the owner shared.
  return sql.query<OpportunityRow & { score: Score | null; checks: Check[]; demand_title: string; seller_alias: string }>(
    `SELECT o.*,
            CASE WHEN o.status = 'invalidated' THEN NULL ELSE a.score END AS score,
            CASE WHEN o.status = 'invalidated' THEN '[]'::jsonb ELSE a.checks END AS checks,
            a.compatibility_status AS compatibility_status,
            dv.data->>'title' AS demand_title, n.alias AS seller_alias
       FROM opportunities o
       JOIN match_assessments a ON a.id = o.assessment_id
       JOIN demand_versions dv ON dv.demand_id = a.demand_id AND dv.version = a.demand_version
       JOIN networks n ON n.id = o.seller_network_id
      WHERE o.buyer_network_id = $1
      ORDER BY o.created_at DESC`,
    [actor.network_id],
  );
}

/** Opportunity detail for the buyer network, re-checking authorization now. */
export async function getOpportunityForActor(sql: Sql, actor: Actor, id: string, now: Date): Promise<OpportunityView> {
  const owner = (await sql.query<{ buyer_network_id: string }>(`SELECT buyer_network_id FROM opportunities WHERE id = $1`, [id]))[0];
  if (!owner || owner.buyer_network_id !== actor.network_id) throw new NotFoundError("Opportunity not found");
  await refreshForActor(sql, actor, now);
  const opp = (await sql.query<OpportunityRow>(`SELECT * FROM opportunities WHERE id = $1`, [id]))[0];
  const a = (await sql.query<AssessmentRow>(`SELECT * FROM match_assessments WHERE id = $1`, [opp.assessment_id]))[0];
  const demand = await getDemandVersion(sql, a.demand_id, a.demand_version);
  if (!demand) throw new NotFoundError("Demand version missing");

  const network = (await sql.query<{ alias: string; name: string }>(`SELECT alias, name FROM networks WHERE id = $1`, [opp.seller_network_id]))[0];
  let lot: InventoryLot | null = null;
  let sellerLabel = `Seller in ${network.alias} (identity withheld)`;
  let note: string | null = null;
  let modelAllowed = false;

  if (opp.novelty === "same_network") {
    modelAllowed = true;
    lot = await getLotVersion(sql, a.lot_id, a.lot_version);
    sellerLabel = `${network.name} (your network)`;
  } else {
    const live = (await visibleLots(sql, actor.network_id, now)).find((v) => v.lot.id === a.lot_id);
    if (opp.status !== "invalidated" && live && `grant:${live.access.grant_id}` === a.permission_version) {
      const assessed = await getLotVersion(sql, a.lot_id, a.lot_version);
      lot = assessed ? projectLot(assessed, live.access) : null;
      const grant = (await sql.query<{ allow_identity_disclosure: boolean; allow_model_processing: boolean }>(`SELECT allow_identity_disclosure, allow_model_processing FROM sharing_grants WHERE id = $1`, [live.access.grant_id]))[0];
      modelAllowed = grant?.allow_model_processing ?? false;
      if (grant?.allow_identity_disclosure) sellerLabel = `${network.name} (${network.alias}, identity disclosed by owner)`;
      if (live.lot.current_version !== a.lot_version) note = "The lot has changed since this assessment.";
    } else {
      note = "The seller's sharing for this lot has ended or the lot is no longer available. Lot details are hidden.";
    }
  }
  return {
    // A stored explanation quotes lot facts, so it goes when access goes.
    opportunity: lot ? opp : { ...opp, explanation: null },
    demand,
    lot,
    seller_label: sellerLabel,
    // Once access ends, only check names and outcomes remain; details and
    // score were derived from lot values the buyer may no longer see.
    checks: lot ? a.checks : a.checks.map((c) => ({ ...c, status: "not_checked" as const, basis: null, detail: "Hidden: access to this lot has ended", fields: [] })),
    score: lot ? a.score : null,
    compatibility_status: a.compatibility_status,
    access_note: note,
    model_processing_allowed: modelAllowed && lot !== null,
  };
}

/**
 * Diagnostics view (plan §7.2.3): candidates rejected by a hard constraint,
 * limited to lots the network may still see under a live grant, current
 * versions only. Checks were computed on the shared projection.
 */
export async function listRejectedForActor(sql: Sql, actor: Actor, now: Date) {
  const visible = new Map((await visibleLots(sql, actor.network_id, now)).map((v) => [v.lot.id, v]));
  const rows = await sql.query<AssessmentRow & { demand_title: string; seller_network_id: string; seller_alias: string }>(
    `SELECT a.*, dv.data->>'title' AS demand_title, l.owner_network_id AS seller_network_id, n.alias AS seller_alias
       FROM match_assessments a
       JOIN demands d ON d.id = a.demand_id AND d.current_version = a.demand_version AND d.status = 'active'
       JOIN demand_versions dv ON dv.demand_id = d.id AND dv.version = d.current_version
       JOIN lots l ON l.id = a.lot_id AND l.current_version = a.lot_version
       JOIN networks n ON n.id = l.owner_network_id
      WHERE d.buyer_network_id = $1 AND a.compatibility_status = 'incompatible'
      ORDER BY a.demand_id, a.lot_id, a.created_at DESC`,
    [actor.network_id],
  );
  const seen = new Set<string>();
  return rows.filter((r) => {
    const v = visible.get(r.lot_id);
    const key = `${r.demand_id}/${r.lot_id}`;
    if (!v || v.permission_version !== r.permission_version || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
