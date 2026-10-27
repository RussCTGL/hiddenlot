import type { Actor } from "@/auth/access";
import type { Db } from "@/db/client";
import { getLot } from "@/db/repo";
import { discoverAll } from "@/discovery/engine";
import { HRC_SCHEMA_VERSION } from "@/domain/hrc";
import { intakeDocument } from "@/ingestion/intake";
import { ALL_LOT_FIELDS, createDemand, createGrant, publishLot, reviewLot, type DemandInput } from "@/workflow/actions";
import { canonicalExtractor, documentBytes, loadCanonical } from "./canonical";

// Loads the synthetic three-network demo (plan §7.1) through the real
// pipeline: intake with evidence checks → owner review → publish → grants →
// demands → discovery. Nothing is inserted around the rules.

const TABLES = [
  "audit_events",
  "review_decisions",
  "opportunities",
  "match_assessments",
  "sharing_grants",
  "demand_versions",
  "demands",
  "lot_versions",
  "lots",
  "extraction_runs",
  "source_fragments",
  "source_documents",
  "users",
  "networks",
];

export async function resetDatabase(db: Db) {
  await db.transaction(async (tx) => {
    for (const t of TABLES) await tx.query(`DELETE FROM ${t}`);
  });
}

export interface SeedReport {
  dataset: string;
  lots: number;
  demands: number;
  grants: number;
  opportunities: number;
}

export async function seedDemo(db: Db, now: Date): Promise<SeedReport> {
  const c = loadCanonical();
  await resetDatabase(db);
  for (const n of c.networks) await db.query(`INSERT INTO networks (id, name, alias, region, synthetic) VALUES ($1,$2,$3,$4,true)`, [n.id, n.name, n.alias, n.region]);
  for (const u of c.users) await db.query(`INSERT INTO users (id, network_id, name, role, synthetic) VALUES ($1,$2,$3,$4,true)`, [u.id, u.network_id, u.name, u.role]);
  const actorOf = (userId: string): Actor => {
    const u = c.users.find((x) => x.id === userId);
    if (!u) throw new Error(`unknown user ${userId}`);
    return { id: u.id, network_id: u.network_id, role: u.role };
  };

  // Stock documents → reviewed, published lots.
  let lots = 0;
  for (const doc of c.documents) {
    const actor = actorOf(doc.uploaded_by);
    const r = await intakeDocument(
      db,
      actor,
      { bytes: documentBytes(doc), filename: doc.file, mime: null, extractor: "canonical_seed", synthetic: true, lot_ids: doc.lots.map((l) => l.lot_id) },
      canonicalExtractor(doc),
      now,
    );
    if (r.status !== "needs_review" || r.lots.length !== doc.lots.length) {
      throw new Error(`seed: ${doc.id} produced ${r.lots.length}/${doc.lots.length} lots (${r.error ?? r.issues.map((i) => i.code).join(", ")})`);
    }
    for (const lotId of r.lots) {
      const lot = await getLot(db, lotId);
      // Scripted stand-in for the owner's review of hand-written truth; the audit
      // note says so. Unknowns stay Unknown (confirming skips empty values).
      await reviewLot(db, actor, lotId, lot!.current_version, ALL_LOT_FIELDS.map((field) => ({ field, action: "confirm" as const })), now, "seed: scripted confirmation of synthetic canonical truth (not a human review)");
      await publishLot(db, actor, lotId, lot!.current_version + 1, now);
      lots++;
    }
  }

  for (const g of c.grants) {
    await createGrant(
      db,
      actorOf(g.created_by),
      {
        recipient_network_id: g.recipient_network_id,
        lot_id: g.lot_id,
        field_scope: g.field_scope === "all" ? ALL_LOT_FIELDS : (g.field_scope as typeof ALL_LOT_FIELDS),
        allow_identity_disclosure: g.allow_identity_disclosure,
        allow_model_processing: g.allow_model_processing,
        expires_at: null,
      },
      now,
      g.id,
    );
  }

  for (const d of c.demands) {
    // buyer_network_id comes from the acting user, not the file.
    const { demand_id, created_by, ...rest } = d;
    const input = Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "buyer_network_id"));
    await createDemand(db, actorOf(created_by), input as unknown as DemandInput, now, demand_id);
  }

  await discoverAll(db, now);
  const opps = await db.query<{ n: string }>(`SELECT count(*) AS n FROM opportunities WHERE status <> 'invalidated'`);
  return { dataset: `${c.dataset}@${c.version} (schema ${HRC_SCHEMA_VERSION})`, lots, demands: c.demands.length, grants: c.grants.length, opportunities: Number(opps[0].n) };
}
