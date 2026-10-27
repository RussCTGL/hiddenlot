import { randomBytes } from "node:crypto";
import { Demand, InventoryLot, type InventoryLotField } from "@/domain/hrc";
import type { Sql } from "./client";

// Row types and data access. Every read that crosses a network boundary goes
// through src/auth/access.ts; functions here assume the caller already holds
// the right to the rows it asks for.

export const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

export interface NetworkRow {
  id: string;
  name: string;
  alias: string;
  region: string | null;
  synthetic: boolean;
}

export interface UserRow {
  id: string;
  network_id: string;
  name: string;
  role: "trader" | "reviewer";
}

export interface DocumentRow {
  id: string;
  network_id: string;
  kind: "text" | "csv" | "xlsx" | "pdf";
  filename: string | null;
  mime: string | null;
  size_bytes: number;
  sha256: string;
  parser_version: string;
  status: string;
  error: string | null;
  synthetic: boolean;
  created_by: string;
  created_at: Date;
}

export interface FragmentRow {
  document_id: string;
  fragment_id: string;
  seq: number;
  text: string;
  locator: Record<string, unknown>;
  cells: { ref: string; sheet: string; row: number; start: number; end: number }[] | null;
}

export interface LotRow {
  id: string;
  owner_network_id: string;
  current_version: number;
  status: InventoryLot["status"];
  source_document_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface LotWithData extends LotRow {
  data: InventoryLot;
}

export interface DemandRow {
  id: string;
  buyer_network_id: string;
  current_version: number;
  status: "active" | "withdrawn" | "expired";
  created_at: Date;
  updated_at: Date;
}

export interface DemandWithData extends DemandRow {
  data: Demand;
}

export interface GrantRow {
  id: string;
  owner_network_id: string;
  recipient_network_id: string;
  lot_id: string | null;
  field_scope: InventoryLotField[];
  purpose: string;
  allow_discovery: boolean;
  allow_model_processing: boolean;
  allow_identity_disclosure: boolean;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_by: string;
  created_at: Date;
}

export interface OpportunityRow {
  id: string;
  assessment_id: string;
  demand_id: string;
  lot_id: string;
  buyer_network_id: string;
  seller_network_id: string;
  novelty: "cross_network" | "same_network";
  compatibility_status: string;
  status: "discovered" | "under_review" | "information_requested" | "shortlisted" | "dismissed" | "invalidated";
  invalidated_reason: string | null;
  explanation: unknown;
  created_at: Date;
  updated_at: Date;
}

export async function audit(sql: Sql, actorId: string | null, action: string, entity: string, entityId: string, detail: object = {}) {
  await sql.query(`INSERT INTO audit_events (actor_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)`, [
    actorId,
    action,
    entity,
    entityId,
    detail,
  ]);
}

// --- networks & users ------------------------------------------------------

export const listNetworks = (sql: Sql) => sql.query<NetworkRow>(`SELECT * FROM networks ORDER BY id`);
export const listUsers = (sql: Sql) => sql.query<UserRow>(`SELECT id, network_id, name, role FROM users ORDER BY network_id, id`);
export async function getUser(sql: Sql, id: string) {
  return (await sql.query<UserRow>(`SELECT id, network_id, name, role FROM users WHERE id = $1`, [id]))[0] ?? null;
}
export async function getNetwork(sql: Sql, id: string) {
  return (await sql.query<NetworkRow>(`SELECT * FROM networks WHERE id = $1`, [id]))[0] ?? null;
}

// --- lots ------------------------------------------------------------------

const LOT_SELECT = `SELECT l.*, v.data FROM lots l JOIN lot_versions v ON v.lot_id = l.id AND v.version = l.current_version`;

export async function getLot(sql: Sql, id: string): Promise<LotWithData | null> {
  return (await sql.query<LotWithData>(`${LOT_SELECT} WHERE l.id = $1`, [id]))[0] ?? null;
}

export async function getLotVersion(sql: Sql, id: string, version: number): Promise<InventoryLot | null> {
  const rows = await sql.query<{ data: InventoryLot }>(`SELECT data FROM lot_versions WHERE lot_id = $1 AND version = $2`, [id, version]);
  return rows[0]?.data ?? null;
}

export const listLotsOfNetwork = (sql: Sql, networkId: string) =>
  sql.query<LotWithData>(`${LOT_SELECT} WHERE l.owner_network_id = $1 ORDER BY l.created_at, l.id`, [networkId]);

export const listLotsOfDocument = (sql: Sql, documentId: string) =>
  sql.query<LotWithData>(`${LOT_SELECT} WHERE l.source_document_id = $1 ORDER BY l.id`, [documentId]);

export async function insertLot(sql: Sql, lot: InventoryLot, documentId: string | null, actorId: string) {
  const data = InventoryLot.parse(lot);
  await sql.query(`INSERT INTO lots (id, owner_network_id, current_version, status, source_document_id) VALUES ($1,$2,$3,$4,$5)`, [
    data.lot_id,
    data.owner_network_id,
    data.version,
    data.status,
    documentId,
  ]);
  await sql.query(`INSERT INTO lot_versions (lot_id, version, data, created_by, change_note) VALUES ($1,$2,$3,$4,$5)`, [
    data.lot_id,
    data.version,
    data,
    actorId,
    "created",
  ]);
  await audit(sql, actorId, "lot.create", "lot", data.lot_id, { version: data.version });
}

export class VersionConflictError extends Error {}

/** Appends a new immutable version. Fails if someone else saved first. */
export async function saveLotVersion(sql: Sql, lotId: string, expectedVersion: number, next: InventoryLot, actorId: string, note: string) {
  const current = await getLot(sql, lotId);
  if (!current) throw new Error(`lot ${lotId} not found`);
  if (current.current_version !== expectedVersion) throw new VersionConflictError(`lot ${lotId} is at v${current.current_version}, not v${expectedVersion}`);
  const version = expectedVersion + 1;
  const data = InventoryLot.parse({ ...next, version });
  await sql.query(`INSERT INTO lot_versions (lot_id, version, data, created_by, change_note) VALUES ($1,$2,$3,$4,$5)`, [lotId, version, data, actorId, note]);
  await sql.query(`UPDATE lots SET current_version = $2, status = $3, updated_at = now() WHERE id = $1`, [lotId, version, data.status]);
  await audit(sql, actorId, "lot.version", "lot", lotId, { version, note });
  return data;
}

// --- demands ---------------------------------------------------------------

const DEMAND_SELECT = `SELECT d.*, v.data FROM demands d JOIN demand_versions v ON v.demand_id = d.id AND v.version = d.current_version`;

export async function getDemand(sql: Sql, id: string): Promise<DemandWithData | null> {
  return (await sql.query<DemandWithData>(`${DEMAND_SELECT} WHERE d.id = $1`, [id]))[0] ?? null;
}

export const listDemandsOfNetwork = (sql: Sql, networkId: string) =>
  sql.query<DemandWithData>(`${DEMAND_SELECT} WHERE d.buyer_network_id = $1 ORDER BY d.created_at, d.id`, [networkId]);

export async function getDemandVersion(sql: Sql, id: string, version: number): Promise<Demand | null> {
  const rows = await sql.query<{ data: Demand }>(`SELECT data FROM demand_versions WHERE demand_id = $1 AND version = $2`, [id, version]);
  return rows[0]?.data ?? null;
}

export async function insertDemand(sql: Sql, demand: Demand, actorId: string) {
  const data = Demand.parse(demand);
  await sql.query(`INSERT INTO demands (id, buyer_network_id, current_version, status) VALUES ($1,$2,$3,'active')`, [
    data.demand_id,
    data.buyer_network_id,
    data.version,
  ]);
  await sql.query(`INSERT INTO demand_versions (demand_id, version, data, created_by) VALUES ($1,$2,$3,$4)`, [data.demand_id, data.version, data, actorId]);
  await audit(sql, actorId, "demand.create", "demand", data.demand_id, { version: data.version });
}

export async function saveDemandVersion(sql: Sql, id: string, expectedVersion: number, next: Demand, actorId: string) {
  const current = await getDemand(sql, id);
  if (!current) throw new Error(`demand ${id} not found`);
  if (current.current_version !== expectedVersion) throw new VersionConflictError(`demand ${id} changed`);
  const data = Demand.parse({ ...next, version: expectedVersion + 1 });
  await sql.query(`INSERT INTO demand_versions (demand_id, version, data, created_by) VALUES ($1,$2,$3,$4)`, [id, data.version, data, actorId]);
  await sql.query(`UPDATE demands SET current_version = $2, updated_at = now() WHERE id = $1`, [id, data.version]);
  await audit(sql, actorId, "demand.version", "demand", id, { version: data.version });
  return data;
}

export async function setDemandStatus(sql: Sql, id: string, status: DemandRow["status"], actorId: string) {
  await sql.query(`UPDATE demands SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
  await audit(sql, actorId, `demand.${status}`, "demand", id);
}

// --- grants ----------------------------------------------------------------

export const listGrantsByOwner = (sql: Sql, ownerNetworkId: string) =>
  sql.query<GrantRow>(`SELECT * FROM sharing_grants WHERE owner_network_id = $1 ORDER BY created_at DESC`, [ownerNetworkId]);

export async function getGrant(sql: Sql, id: string) {
  return (await sql.query<GrantRow>(`SELECT * FROM sharing_grants WHERE id = $1`, [id]))[0] ?? null;
}

export async function insertGrant(sql: Sql, g: Omit<GrantRow, "id" | "created_at" | "revoked_at" | "purpose">, id = newId("grant")) {
  await sql.query(
    `INSERT INTO sharing_grants (id, owner_network_id, recipient_network_id, lot_id, field_scope, allow_discovery, allow_model_processing, allow_identity_disclosure, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, g.owner_network_id, g.recipient_network_id, g.lot_id, JSON.stringify(g.field_scope), g.allow_discovery, g.allow_model_processing, g.allow_identity_disclosure, g.expires_at, g.created_by],
  );
  await audit(sql, g.created_by, "grant.create", "grant", id, { recipient: g.recipient_network_id, lot: g.lot_id });
  return id;
}

/** Active grants that let `recipient` use published lots in discovery, one row per (grant, lot). */
export async function sharedLotsFor(sql: Sql, recipientNetworkId: string, now: Date) {
  return sql.query<LotWithData & { grant_id: string; field_scope: InventoryLotField[]; allow_identity_disclosure: boolean; grant_created_at: Date }>(
    `SELECT l.*, v.data, g.id AS grant_id, g.field_scope, g.allow_identity_disclosure, g.created_at AS grant_created_at
       FROM sharing_grants g
       JOIN lots l ON l.owner_network_id = g.owner_network_id AND (g.lot_id IS NULL OR g.lot_id = l.id)
       JOIN lot_versions v ON v.lot_id = l.id AND v.version = l.current_version
      WHERE g.recipient_network_id = $1
        AND g.allow_discovery
        AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > $2)
        AND l.status = 'published'
      ORDER BY l.id, g.created_at DESC, g.id DESC`,
    [recipientNetworkId, now],
  );
}

// --- opportunities ---------------------------------------------------------

export async function getOpportunity(sql: Sql, id: string) {
  return (await sql.query<OpportunityRow>(`SELECT * FROM opportunities WHERE id = $1`, [id]))[0] ?? null;
}
