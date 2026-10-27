import { z } from "zod";
import { ForbiddenError, getOpportunityForActor, getOwnDemand, getOwnLot, NotFoundError, type Actor } from "@/auth/access";
import type { Db } from "@/db/client";
import {
  audit,
  getGrant,
  insertDemand,
  insertGrant,
  newId,
  saveDemandVersion,
  saveLotVersion,
  setDemandStatus,
  type GrantRow,
} from "@/db/repo";
import { REVIEWABLE } from "@/discovery/constraints";
import { discoverForDemand, discoverForLot, invalidateStale, type DiscoveryStats } from "@/discovery/engine";
import { Demand, HRC_SCHEMA_VERSION, InventoryLot, InventoryLotFields, type InventoryLotField } from "@/domain/hrc";

// State changes (plan §16.1, §8.4). Each one checks the actor, writes an
// immutable version or decision with an audit event, then re-runs discovery
// or invalidation so no opportunity outlives the facts it was built on.
// Nothing here sends a message, reserves stock or commits anyone to a trade.

export const ALL_LOT_FIELDS = Object.keys(InventoryLotFields.shape) as InventoryLotField[];

// --- lot review & publication ----------------------------------------------

export type FieldEdit =
  | { field: InventoryLotField; action: "confirm" }
  | { field: InventoryLotField; action: "correct"; value: unknown; note: string };

/**
 * Owner review. Confirming keeps the extracted value and marks it reviewed;
 * correcting replaces it and keeps the original in the previous version.
 */
export async function reviewLot(db: Db, actor: Actor, lotId: string, expectedVersion: number, edits: FieldEdit[], now: Date, note?: string) {
  return db.transaction(async (tx) => {
    const lot = await getOwnLot(tx, actor, lotId);
    const fields = structuredClone(lot.data.fields) as Record<InventoryLotField, InventoryLot["fields"][InventoryLotField]>;
    for (const e of edits) {
      const obs = fields[e.field];
      if (!obs) throw new Error(`unknown field ${e.field}`);
      if (e.action === "confirm") {
        if (obs.normalized_value === null) continue; // nothing to confirm; Unknown stays Unknown
        fields[e.field] = { ...obs, status: "user_confirmed", review: { status: "confirmed", reviewer_id: actor.id } };
      } else {
        // A correction is the reviewer's statement, not the source's: the old
        // evidence and normalization stay in the previous version only.
        fields[e.field] = {
          ...obs,
          raw_value: null,
          normalized_value: e.value as never,
          unit: null,
          status: e.value === null ? "not_stated" : "user_corrected",
          evidence: [],
          normalization: null,
          issues: e.note ? [`corrected: ${e.note}`] : [],
          review: { status: "corrected", reviewer_id: actor.id },
        };
      }
    }
    const next = InventoryLot.parse({ ...lot.data, fields });
    const saved = await saveLotVersion(tx, lotId, expectedVersion, next, actor.id, note ?? `review: ${edits.length} field(s)`);
    const stats = lot.status === "published" ? await discoverForLot(tx, lotId, now) : null;
    return { lot: saved, stats };
  });
}

/** Publishing makes the lot available to discovery under the owner's grants. */
export async function publishLot(db: Db, actor: Actor, lotId: string, expectedVersion: number, now: Date) {
  return db.transaction(async (tx) => {
    const lot = await getOwnLot(tx, actor, lotId);
    if (lot.status === "sold" || lot.status === "withdrawn") throw new ForbiddenError(`Lot is ${lot.status}`);
    const next: InventoryLot = { ...lot.data, status: "published", last_verified_at: now.toISOString() };
    const saved = await saveLotVersion(tx, lotId, expectedVersion, next, actor.id, "published");
    const stats = await discoverForLot(tx, lotId, now);
    return { lot: saved, stats };
  });
}

/** Seller reconfirms the stock is still there (freshness, plan §12.4). */
export async function reconfirmLot(db: Db, actor: Actor, lotId: string, expectedVersion: number, now: Date) {
  return db.transaction(async (tx) => {
    const lot = await getOwnLot(tx, actor, lotId);
    const saved = await saveLotVersion(tx, lotId, expectedVersion, { ...lot.data, last_verified_at: now.toISOString() }, actor.id, "stock reconfirmed");
    const stats = lot.status === "published" ? await discoverForLot(tx, lotId, now) : null;
    return { lot: saved, stats };
  });
}

export async function setLotStatus(db: Db, actor: Actor, lotId: string, expectedVersion: number, status: "sold" | "withdrawn", now: Date) {
  return db.transaction(async (tx) => {
    const lot = await getOwnLot(tx, actor, lotId);
    const saved = await saveLotVersion(tx, lotId, expectedVersion, { ...lot.data, status }, actor.id, status);
    const invalidated = await invalidateStale(tx, now);
    return { lot: saved, invalidated };
  });
}

// --- demands ---------------------------------------------------------------

export const DemandInput = Demand.omit({ schema_version: true, demand_id: true, version: true, buyer_network_id: true, synthetic: true });
export type DemandInput = z.infer<typeof DemandInput>;

export async function createDemand(db: Db, actor: Actor, input: DemandInput, now: Date, id = newId("dem")) {
  return db.transaction(async (tx) => {
    const demand = Demand.parse({ ...DemandInput.parse(input), schema_version: HRC_SCHEMA_VERSION, demand_id: id, version: 1, buyer_network_id: actor.network_id, synthetic: true });
    await insertDemand(tx, demand, actor.id);
    const stats = await discoverForDemand(tx, id, now);
    return { demand, stats };
  });
}

export async function updateDemand(db: Db, actor: Actor, id: string, expectedVersion: number, input: DemandInput, now: Date) {
  return db.transaction(async (tx) => {
    const current = await getOwnDemand(tx, actor, id);
    const demand = await saveDemandVersion(tx, id, expectedVersion, { ...current.data, ...DemandInput.parse(input) }, actor.id);
    const stats = await discoverForDemand(tx, id, now);
    return { demand, stats };
  });
}

export async function withdrawDemand(db: Db, actor: Actor, id: string, now: Date) {
  return db.transaction(async (tx) => {
    await getOwnDemand(tx, actor, id);
    await setDemandStatus(tx, id, "withdrawn", actor.id);
    return { invalidated: await invalidateStale(tx, now) };
  });
}

// --- sharing ---------------------------------------------------------------

export interface GrantInput {
  recipient_network_id: string;
  lot_id: string | null;
  field_scope: InventoryLotField[];
  allow_identity_disclosure: boolean;
  /** May the recipient send these shared fields to the model (explanations)? Off unless chosen. */
  allow_model_processing?: boolean;
  expires_at: Date | null;
}

export async function createGrant(db: Db, actor: Actor, input: GrantInput, now: Date, id?: string): Promise<{ grant_id: string; stats: DiscoveryStats[] }> {
  return db.transaction(async (tx) => {
    if (input.recipient_network_id === actor.network_id) throw new ForbiddenError("Cannot share with your own network");
    if (input.lot_id) await getOwnLot(tx, actor, input.lot_id);
    const scope = input.field_scope.filter((f) => ALL_LOT_FIELDS.includes(f));
    const grantId = await insertGrant(
      tx,
      {
        owner_network_id: actor.network_id,
        recipient_network_id: input.recipient_network_id,
        lot_id: input.lot_id,
        field_scope: scope,
        allow_discovery: true,
        allow_model_processing: input.allow_model_processing ?? false,
        allow_identity_disclosure: input.allow_identity_disclosure,
        expires_at: input.expires_at,
        created_by: actor.id,
      },
      id,
    );
    // Run discovery for the recipient's demands against the newly visible lots.
    const lots = input.lot_id
      ? [input.lot_id]
      : (await tx.query<{ id: string }>(`SELECT id FROM lots WHERE owner_network_id = $1 AND status = 'published'`, [actor.network_id])).map((r) => r.id);
    const stats: DiscoveryStats[] = [];
    for (const lotId of lots) stats.push(await discoverForLot(tx, lotId, now));
    return { grant_id: grantId, stats };
  });
}

/** Revocation blocks the recipient immediately: opportunities are invalidated and details hidden. */
export async function revokeGrant(db: Db, actor: Actor, grantId: string, now: Date) {
  return db.transaction(async (tx) => {
    const g: GrantRow | null = await getGrant(tx, grantId);
    if (!g || g.owner_network_id !== actor.network_id) throw new NotFoundError("Grant not found");
    if (g.revoked_at) return { invalidated: 0 };
    await tx.query(`UPDATE sharing_grants SET revoked_at = $2 WHERE id = $1`, [grantId, now]);
    await audit(tx, actor.id, "grant.revoke", "grant", grantId);
    return { invalidated: await invalidateStale(tx, now) };
  });
}

// --- opportunity review ------------------------------------------------------

export const ReviewDecision = z.enum(["under_review", "information_requested", "shortlisted", "dismissed"]);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

/**
 * Buyer-side review. Saved with actor, reason and the exact versions it was
 * made on. "information_requested" is an internal to-do; nothing is sent.
 */
export async function decideOpportunity(db: Db, actor: Actor, oppId: string, decision: ReviewDecision, reason: string, now: Date) {
  const why = reason.trim();
  if (!why) throw new Error("A reason is required");
  return db.transaction(async (tx) => {
    const view = await getOpportunityForActor(tx, actor, oppId, now);
    if (view.opportunity.status === "invalidated") throw new ForbiddenError("This opportunity was invalidated; re-run discovery for the current versions");
    if (view.lot === null) throw new ForbiddenError("Access to this lot has ended");
    if (view.compatibility_status === "incompatible") throw new ForbiddenError("Incompatible candidates cannot be shortlisted");
    // Shortlisting is only for candidates whose hard checks all passed. A
    // different grade (engineering review) or missing evidence must first be
    // resolved, which produces a new assessment.
    if (decision === "shortlisted" && !REVIEWABLE.includes(view.compatibility_status)) {
      throw new ForbiddenError(
        view.compatibility_status === "engineering_review_required"
          ? "A different grade needs engineering review and buyer approval before it can be shortlisted"
          : "Request the missing information before shortlisting",
      );
    }
    const a = (await tx.query<{ lot_id: string; lot_version: number; demand_id: string; demand_version: number; permission_version: string; rules_version: string }>(
      `SELECT lot_id, lot_version, demand_id, demand_version, permission_version, rules_version FROM match_assessments WHERE id = $1`,
      [view.opportunity.assessment_id],
    ))[0];
    const id = newId("rev");
    await tx.query(`INSERT INTO review_decisions (id, opportunity_id, actor_id, decision, reason, evidence_version) VALUES ($1,$2,$3,$4,$5,$6)`, [
      id,
      oppId,
      actor.id,
      decision,
      why,
      { assessment_id: view.opportunity.assessment_id, ...a },
    ]);
    const updated = await tx.query(`UPDATE opportunities SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'invalidated' RETURNING id`, [oppId, decision]);
    if (updated.length === 0) throw new ForbiddenError("This opportunity was invalidated");
    await audit(tx, actor.id, `opportunity.${decision}`, "opportunity", oppId, { reason: why });
    return { id };
  });
}

export async function listDecisions(db: Db, actor: Actor, oppId: string) {
  const opp = (await db.query<{ buyer_network_id: string }>(`SELECT buyer_network_id FROM opportunities WHERE id = $1`, [oppId]))[0];
  if (!opp || opp.buyer_network_id !== actor.network_id) throw new NotFoundError("Opportunity not found");
  return db.query<{ id: string; actor_id: string; decision: string; reason: string; evidence_version: object; created_at: Date }>(
    `SELECT * FROM review_decisions WHERE opportunity_id = $1 ORDER BY created_at`,
    [oppId],
  );
}
