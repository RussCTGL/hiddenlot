import { ForbiddenError, getOpportunityForActor, listOpportunitiesForActor, listRejectedForActor, NotFoundError, type Actor, type OpportunityView } from "@/auth/access";
import type { Db, Sql } from "@/db/client";
import { audit, newId, type DemandWithData } from "@/db/repo";
import { FRESHNESS_WINDOW_HOURS, REVIEWABLE, stockAgeHours, type Check, type CompatibilityStatus } from "@/discovery/constraints";
import { projectLot, visibleLots, type VisibleLot } from "@/discovery/engine";
import { compareDecimal } from "@/discovery/score";
import type { Demand, InventoryLot, InventoryLotField } from "@/domain/hrc";
import { findPlace, type Place } from "@/geo/places";
import { decideOpportunity } from "./actions";

// Daily digest and deal tracking.
//
// The digest is computed, not stored: every suggestion comes from rule results
// (assessments), deal state and the clock. Accepting a suggestion recomputes
// the digest on the server and runs only suggestions that still exist, so a
// stale page can never trigger something the rules no longer support.
//
// Messages are drafts built from the fields the owner shared with this
// network. Nothing is sent: the buyer copies a draft and sends it themselves,
// and HiddenLot records that they did and when to follow up.

export const DEAL_STAGES = ["waiting", "quote_requested", "quote_in_hand", "negotiating", "won", "lost"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
export const OPEN_STAGES: DealStage[] = ["waiting", "quote_requested", "quote_in_hand", "negotiating"];
export const STAGE_LABEL: Record<DealStage, string> = {
  waiting: "Waiting for an answer",
  quote_requested: "Quote requested",
  quote_in_hand: "Quote in hand",
  negotiating: "Negotiating",
  won: "Won",
  lost: "Lost",
};

/** Days the buyer gives a seller to answer before the digest flags silence. */
export const FOLLOW_UP_DAYS = 2;

export interface Quote {
  price: string;
  currency: string;
  incoterm: string;
  valid_until: string | null;
  quantity_t: number | null;
}

export interface DealRow {
  id: string;
  buyer_network_id: string;
  demand_id: string;
  lot_id: string;
  stage: DealStage;
  ask: string | null;
  follow_up_on: string | null;
  snoozed_until: string | null;
  quote: Quote | null;
  closed_reason: string | null;
  lot_version_at_start: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const DEAL_COLS = `id, buyer_network_id, demand_id, lot_id, stage, ask, follow_up_on::text AS follow_up_on, snoozed_until::text AS snoozed_until,
  quote, closed_reason, lot_version_at_start, created_by, created_at, updated_at`;

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => isoDay(new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86_400_000));
export const fmtDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

// --- lot wording (shared fields only) -------------------------------------------

function val<T>(lot: InventoryLot, f: InventoryLotField): T | null {
  const o = lot.fields[f];
  return o.status === "not_stated" || o.status === "unresolved" ? null : (o.normalized_value as T | null);
}
const num = (x: number) => String(Math.round(x * 1000) / 1000);

/** "SS400 · 3 × 1500 mm · 18 t", from what this network may see. */
export function lotTitle(lot: InventoryLot) {
  const t = val<number>(lot, "thickness_mm");
  const w = val<number>(lot, "width_mm");
  const kg = val<number>(lot, "total_kg");
  return [val<string>(lot, "grade_raw") ?? "Grade ?", `${t === null ? "?" : num(t)} × ${w === null ? "?" : num(w)} mm`, kg === null ? "? t" : `${num(kg / 1000)} t`].join(" · ");
}

/** The seller's own reference when shared, else the internal lot ID. */
export function lotRef(lot: InventoryLot | null, lotId: string) {
  return (lot && val<string>(lot, "seller_lot_ref")) ?? lotId.replace(/^lot[-_]/, "").toUpperCase();
}

function standardText(lot: InventoryLot) {
  const std = val<string>(lot, "standard_id");
  const ed = val<string>(lot, "standard_edition");
  return std && (ed ? `${std}-${ed}` : std);
}

function spec(lot: InventoryLot) {
  const t = val<number>(lot, "thickness_mm");
  const w = val<number>(lot, "width_mm");
  const kg = val<number>(lot, "total_kg");
  return [
    [val<string>(lot, "grade_raw"), standardText(lot)].filter(Boolean).join(" "),
    t !== null && w !== null ? `${num(t)} × ${num(w)} mm` : null,
    kg !== null ? `${num(kg / 1000)} t` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function terms(lot: InventoryLot) {
  const inc = val<string>(lot, "incoterm");
  const place = val<string>(lot, "incoterm_place");
  const price = val<string>(lot, "price_amount");
  const cur = val<string>(lot, "price_currency");
  const basis = val<string>(lot, "price_basis");
  return [inc && [inc, place].filter(Boolean).join(" "), price && cur ? `${cur} ${price}${basis === "per_mt" ? "/MT" : basis === "per_lot" ? " per lot" : ""}` : null].filter(Boolean).join(", ");
}

// --- drafts -------------------------------------------------------------------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Lower-cases a sentence start for joining, but leaves codes like "GB/T" or "MTC" alone. */
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
/** Messages to another network open with a greeting; notes to a colleague do not. */
const message = (own: boolean, body: string) => (own ? cap(body) : `Hello, ${body}`);

export function quoteRequestDraft(lot: InventoryLot, lotId: string, demand: Demand, own: boolean, checks: Check[]) {
  const t = terms(lot);
  const claimCert = checks.some((c) => c.id === "certificates" && c.status === "pass" && c.basis === "seller_claim");
  return [
    message(own, `we are interested in lot ${lotRef(lot, lotId)} (${[spec(lot), t].filter(Boolean).join(", ")}).`),
    `Could you send a firm offer valid for 3 days?`,
    demand.need_by ? `Delivery needed by ${fmtDay(demand.need_by)}.` : null,
    claimCert ? `Please include a copy of the ${demand.must_have_certificates.join(" and ")}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The question that settles one unknown check, or null when the buyer must answer it. */
export function questionFor(c: Check, demand: Demand, lot: InventoryLot): string | null {
  if (c.ask !== "seller") return null;
  if (c.detail.startsWith("Not shared by the lot owner")) return `could you share the ${c.label.toLowerCase()}?`;
  switch (c.id) {
    case "certificates": {
      const certs = demand.must_have_certificates.join(" and ");
      // Letter names that start with a vowel sound: "an MTC", "a COA".
      return `is ${/^[AEFHILMNORSX][A-Z]/.test(certs) ? "an" : "a"} ${certs} available for this lot?`;
    }
    case "standard": {
      const std = val<string>(lot, "standard_id");
      return std ? `which edition of ${std} was it produced to?` : "which standard and edition was it produced to?";
    }
    case "condition":
      return "is it prime or secondary? If secondary, please describe the defects.";
    case "freshness":
      return "is it still available at the same terms?";
    case "quantity":
      return c.detail.includes("split") ? "can the lot be split into a smaller quantity?" : "what is the total weight in tonnes?";
    case "thickness":
    case "width":
      return `what is the ${c.label.toLowerCase()} in mm?`;
    case "available_date":
      return "from what date is it available?";
    case "grade":
      return "what grade is it?";
    case "product_form":
      return "is it coil, plate or sheet?";
    default:
      return null;
  }
}

/** Short form of an open question for one-line lists: "MTC", "GB/T 700 edition". */
function topicFor(c: Check, demand: Demand, lot: InventoryLot): string {
  if (c.detail.startsWith("Not shared by the lot owner")) return c.label.toLowerCase();
  switch (c.id) {
    case "certificates":
      return demand.must_have_certificates.join(", ");
    case "standard": {
      const std = val<string>(lot, "standard_id");
      return std ? `${std} edition` : "standard";
    }
    case "freshness":
      return "still available";
    case "quantity":
      return c.detail.includes("split") ? "split" : "weight";
    case "available_date":
      return "ready date";
    default:
      return c.label.toLowerCase();
  }
}

/**
 * Where a lot can be drawn, from shared fields only: the stock location when the
 * owner shared it; otherwise the port it ships from (FOB and similar terms; a
 * loading port is not taken to be where the stock sits); otherwise the port it is
 * delivered to (CFR and similar). Null when none is shared or the place is unknown.
 */
export interface Where extends Place {
  kind: "stock" | "ships_from" | "delivered";
  terms: string | null;
}
const SHIPS_FROM = ["EXW", "FCA", "FAS", "FOB"];
const DELIVERED = ["CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"];

export function whereOf(lot: InventoryLot): Where | null {
  const inc = val<string>(lot, "incoterm")?.toUpperCase() ?? null;
  const incPlace = findPlace(val<string>(lot, "incoterm_place"));
  const terms = inc && incPlace ? `${inc} ${incPlace.name}` : null;
  const stock = findPlace(val<string>(lot, "location_place"));
  if (stock) return { ...stock, kind: "stock", terms };
  if (inc && incPlace && SHIPS_FROM.includes(inc)) return { ...incPlace, kind: "ships_from", terms };
  if (inc && incPlace && DELIVERED.includes(inc)) return { ...incPlace, kind: "delivered", terms };
  return null;
}

const askDraft = (lot: InventoryLot, lotId: string, own: boolean, question: string) => message(own, `for lot ${lotRef(lot, lotId)} (${spec(lot)}): ${question}`);

const reconfirmDraft = (lot: InventoryLot, lotId: string, own: boolean) =>
  message(own, `could you reconfirm that lot ${lotRef(lot, lotId)} (${spec(lot)}) is still available, at the same terms?`);

// --- loading ---------------------------------------------------------------------

export async function getDealForBuyer(sql: Sql, actor: Actor, id: string): Promise<DealRow> {
  const d = (await sql.query<DealRow>(`SELECT ${DEAL_COLS} FROM deals WHERE id = $1`, [id]))[0];
  if (!d || d.buyer_network_id !== actor.network_id) throw new NotFoundError("Deal not found");
  return d;
}

const openDealsOf = (sql: Sql, networkId: string) =>
  sql.query<DealRow>(`SELECT ${DEAL_COLS} FROM deals WHERE buyer_network_id = $1 AND stage IN ('waiting','quote_requested','quote_in_hand','negotiating') ORDER BY created_at`, [networkId]);

async function event(sql: Sql, dealId: string, actorId: string | null, kind: string, note: string, now: Date) {
  await sql.query(`INSERT INTO deal_events (id, deal_id, actor_id, kind, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [newId("dev"), dealId, actorId, kind, note, now]);
}

async function update(sql: Sql, deal: DealRow, patch: Partial<Pick<DealRow, "stage" | "ask" | "follow_up_on" | "snoozed_until" | "quote" | "closed_reason">>, now: Date) {
  const next = { ...deal, ...patch };
  await sql.query(
    `UPDATE deals SET stage = $2, ask = $3, follow_up_on = $4, snoozed_until = $5, quote = $6, closed_reason = $7, updated_at = $8 WHERE id = $1`,
    [deal.id, next.stage, next.ask, next.follow_up_on, next.snoozed_until, next.quote === null ? null : JSON.stringify(next.quote), next.closed_reason, now],
  );
  return next;
}

/**
 * Closes open deals the buyer can no longer act on: the lot was sold or
 * withdrawn, sharing ended, or the demand was withdrawn or expired.
 */
export async function syncDeals(db: Db, actor: Actor, now: Date, visible?: Map<string, VisibleLot>) {
  const deals = await openDealsOf(db, actor.network_id);
  if (deals.length === 0) return 0;
  const vis = visible ?? new Map((await visibleLots(db, actor.network_id, now)).map((v) => [v.lot.id, v]));
  const lots = new Map((await db.query<{ id: string; status: string }>(`SELECT id, status FROM lots WHERE id = ANY($1)`, [deals.map((d) => d.lot_id)])).map((l) => [l.id, l.status]));
  const demands = new Map(
    (
      await db.query<{ id: string; status: string; expires_at: string | null }>(
        `SELECT d.id, d.status, v.data->>'expires_at' AS expires_at FROM demands d JOIN demand_versions v ON v.demand_id = d.id AND v.version = d.current_version WHERE d.id = ANY($1)`,
        [deals.map((d) => d.demand_id)],
      )
    ).map((d) => [d.id, d]),
  );
  let closed = 0;
  for (const d of deals) {
    const lotStatus = lots.get(d.lot_id);
    const dem = demands.get(d.demand_id);
    const reason =
      lotStatus === "sold" || lotStatus === "withdrawn"
        ? `Lot is ${lotStatus}`
        : dem && dem.status !== "active"
          ? `Demand is ${dem.status}`
          : dem?.expires_at && new Date(dem.expires_at) <= now
            ? "Demand expired"
            : !vis.has(d.lot_id)
              ? "Sharing ended"
              : null;
    if (!reason) continue;
    await db.transaction(async (tx) => {
      await update(tx, d, { stage: "lost", closed_reason: reason, follow_up_on: null }, now);
      await event(tx, d.id, null, "closed", `Closed as lost automatically: ${reason.toLowerCase()}`, now);
      await audit(tx, null, "deal.auto_closed", "deal", d.id, { reason });
    });
    closed++;
  }
  return closed;
}

/** Opens a deal for an opportunity the buyer acted on, or moves the open deal on that pair. */
export async function startDeal(db: Db, actor: Actor, oppId: string, stage: "waiting" | "quote_requested", ask: string | null, note: string, now: Date) {
  return db.transaction(async (tx) => {
    const opp = (await tx.query<{ id: string; buyer_network_id: string; demand_id: string; lot_id: string; status: string }>(`SELECT id, buyer_network_id, demand_id, lot_id, status FROM opportunities WHERE id = $1`, [oppId]))[0];
    if (!opp || opp.buyer_network_id !== actor.network_id) throw new NotFoundError("Opportunity not found");
    if (opp.status === "invalidated") throw new ForbiddenError("This opportunity was invalidated");
    const today = isoDay(now);
    const existing = (await tx.query<DealRow>(`SELECT ${DEAL_COLS} FROM deals WHERE demand_id = $1 AND lot_id = $2 AND stage IN ('waiting','quote_requested','quote_in_hand','negotiating')`, [opp.demand_id, opp.lot_id]))[0];
    if (existing) {
      await update(tx, existing, { stage, ask, follow_up_on: addDays(today, FOLLOW_UP_DAYS), snoozed_until: null }, now);
      await event(tx, existing.id, actor.id, stage, note, now);
      return existing.id;
    }
    const lotVersion = (await tx.query<{ current_version: number }>(`SELECT current_version FROM lots WHERE id = $1`, [opp.lot_id]))[0].current_version;
    const id = newId("deal");
    await tx.query(
      `INSERT INTO deals (id, buyer_network_id, demand_id, lot_id, stage, ask, follow_up_on, lot_version_at_start, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [id, actor.network_id, opp.demand_id, opp.lot_id, stage, ask, addDays(today, FOLLOW_UP_DAYS), lotVersion, actor.id, now],
    );
    await event(tx, id, actor.id, stage, note, now);
    await audit(tx, actor.id, "deal.start", "deal", id, { opportunity: oppId, stage });
    return id;
  });
}

// --- the pair as the buyer may see it now ------------------------------------------

interface PairState {
  /** Current open opportunity on the pair, if any. */
  opp: { id: string; status: string; compatibility_status: CompatibilityStatus; checks: Check[]; novelty: string; score: { observed: number | null } | null } | null;
  /** The lot projected to the live grant scope; null when the buyer may no longer see it. */
  lot: InventoryLot | null;
  own: boolean;
  sellerLabel: string;
  /** Hard-constraint failures of the current assessment when no opportunity is open. */
  fails: Check[];
}

interface Context {
  now: Date;
  today: string;
  visible: Map<string, VisibleLot>;
  opps: Awaited<ReturnType<typeof listOpportunitiesForActor>>;
  rejected: Awaited<ReturnType<typeof listRejectedForActor>>;
  demands: Map<string, DemandWithData>;
  alias: Map<string, string>;
}

async function loadContext(db: Db, actor: Actor, now: Date): Promise<Context> {
  // The opportunity list refreshes discovery for this network first.
  const opps = await listOpportunitiesForActor(db, actor, now);
  const visible = new Map((await visibleLots(db, actor.network_id, now)).map((v) => [v.lot.id, v]));
  await syncDeals(db, actor, now, visible);
  const rejected = await listRejectedForActor(db, actor, now);
  const demands = new Map(
    (
      await db.query<DemandWithData>(
        `SELECT d.*, v.data FROM demands d JOIN demand_versions v ON v.demand_id = d.id AND v.version = d.current_version WHERE d.buyer_network_id = $1`,
        [actor.network_id],
      )
    ).map((d) => [d.id, d]),
  );
  const alias = new Map((await db.query<{ id: string; alias: string }>(`SELECT id, alias FROM networks`)).map((n) => [n.id, n.alias]));
  return { now, today: isoDay(now), visible, opps, rejected, demands, alias };
}

function pairState(ctx: Context, actor: Actor, demandId: string, lotId: string): PairState {
  const v = ctx.visible.get(lotId);
  const opp = ctx.opps.find((o) => o.demand_id === demandId && o.lot_id === lotId && o.status !== "invalidated") ?? null;
  const own = v ? v.access.own : false;
  const owner = v?.lot.owner_network_id;
  return {
    opp: opp && { id: opp.id, status: opp.status, compatibility_status: opp.compatibility_status as CompatibilityStatus, checks: opp.checks, novelty: opp.novelty, score: opp.score },
    lot: v ? projectLot(v.lot.data, v.access) : null,
    own,
    sellerLabel: own ? "your network" : owner ? (ctx.alias.get(owner) ?? "another network") : "another network",
    fails: opp ? [] : (ctx.rejected.find((r) => r.demand_id === demandId && r.lot_id === lotId)?.checks.filter((c) => c.status === "fail") ?? []),
  };
}

// --- risks on open deals -------------------------------------------------------------

const RISK_BUTTON: Record<Risk["action"], string> = {
  reconfirm: "Ask to reconfirm",
  request_quote: "Ask for quote",
  close_lost: "Close as lost",
  review_change: "Mark reviewed",
  requote: "Ask if offer stands",
  follow_up: "Follow up",
};

export interface Risk {
  action: "reconfirm" | "request_quote" | "close_lost" | "review_change" | "requote" | "follow_up";
  badge: string;
  reason: string;
  label: string;
  draft: string | null;
}

function dealRisk(deal: DealRow, pair: PairState, ctx: Context): Risk | null {
  if (deal.snoozed_until && deal.snoozed_until > ctx.today) return null;
  const lot = pair.lot;
  if (!lot) return null; // closed by syncDeals
  const seller = pair.own ? "The lot owner" : pair.sellerLabel;
  // Rounded up, so a lot just past the window never reads "48 h".
  const age = Math.ceil(stockAgeHours(lot, ctx.now));
  if (stockAgeHours(lot, ctx.now) > FRESHNESS_WINDOW_HOURS) {
    return {
      action: "reconfirm",
      badge: `Stock not reconfirmed · ${age} h`,
      reason: `${seller} last confirmed this stock ${age} hours ago. The window is ${FRESHNESS_WINDOW_HOURS} hours. Ask them to reconfirm before you ${deal.stage === "waiting" ? "go further" : "accept a quote"}.`,
      label: `ask ${pair.own ? "the lot owner" : pair.sellerLabel} to reconfirm stock`,
      draft: reconfirmDraft(lot, deal.lot_id, pair.own),
    };
  }
  if (!pair.opp) {
    const why = pair.fails.map((c) => c.detail).join("; ");
    return { action: "close_lost", badge: "A requirement now fails", reason: why ? `After the latest change: ${why}.` : "The lot no longer meets this demand.", label: "close as lost", draft: null };
  }
  const reviewable = REVIEWABLE.includes(pair.opp.compatibility_status);
  if (deal.stage === "waiting" && reviewable) {
    return { action: "request_quote", badge: "Answer is in", reason: "Every hard requirement passes now. Ask for a firm offer.", label: "request a quote", draft: null };
  }
  if (deal.stage !== "waiting" && !reviewable) {
    const open = pair.opp.checks.filter((c) => c.status === "unknown" || c.status === "review").map((c) => c.label.toLowerCase());
    return { action: "review_change", badge: "Something changed", reason: `The latest assessment no longer passes every check: ${open.join(", ") || "see the requirements"}.`, label: "review the change", draft: null };
  }
  if (deal.quote?.valid_until && deal.quote.valid_until < ctx.today && deal.stage !== "waiting") {
    return {
      action: "requote",
      badge: `Quote expired ${fmtDay(deal.quote.valid_until)}`,
      reason: `${seller}'s offer was valid until ${fmtDay(deal.quote.valid_until)}.`,
      label: "ask whether the offer still stands",
      draft: message(pair.own, `your offer for lot ${lotRef(lot, deal.lot_id)} was valid until ${fmtDay(deal.quote.valid_until)}. Does it still stand?`),
    };
  }
  if (deal.follow_up_on && deal.follow_up_on <= ctx.today && (deal.stage === "waiting" || deal.stage === "quote_requested")) {
    const asked = deal.stage === "waiting" ? deal.ask : "a firm offer";
    return {
      action: "follow_up",
      badge: "No reply yet",
      reason: `You asked ${pair.own ? "the lot owner" : pair.sellerLabel} for ${deal.stage === "waiting" ? "an answer" : "an offer"}. Nothing recorded since.`,
      label: "follow up",
      draft: message(pair.own, `following up on lot ${lotRef(lot, deal.lot_id)} (${spec(lot)}): ${deal.stage === "waiting" && asked ? lower(asked) : "could you send a firm offer?"}`),
    };
  }
  return null;
}

// --- the digest ----------------------------------------------------------------------

export interface Suggestion {
  key: string;
  section: "risk" | "forward" | "ask";
  action: Risk["action"] | "shortlist" | "ask";
  title: string;
  ref: string;
  href: string;
  status: CompatibilityStatus | null;
  badge: string | null;
  reason: string;
  facts: { ok: boolean; text: string }[];
  draft: string | null;
  label: string;
  priority: number | null;
  question: string | null;
  oppId: string | null;
  dealId: string | null;
  /** Short reference, seller and one-line summary for compact lists. */
  lotRef: string;
  seller: string;
  sub: string;
  /** Label of the button that runs this suggestion. */
  button: string;
  where: Where | null;
  /** The demand's delivery port, when it names one we know. */
  destination: Place | null;
}

/** Parked, incomplete or ruled-out lots: listed and drawn, but no suggested action. */
export interface DigestItem {
  key: string;
  lotRef: string;
  title: string;
  text: string;
  href: string | null;
  where: Where | null;
}

export interface Digest {
  now: Date;
  hasDemands: boolean;
  stats: { lots: number; candidates: number; deals: number; ruledOut: number };
  risks: Suggestion[];
  forward: Suggestion[];
  ask: Suggestion[];
  engineering: DigestItem[];
  missing: DigestItem[];
  ruledOut: DigestItem[];
  staleOwnLots: number;
}

const FACT_IDS = ["grade", "standard", "thickness", "width", "quantity", "available_date", "certificates"] as const;

function facts(checks: Check[], demand: Demand, lot: InventoryLot) {
  const out: { ok: boolean; text: string }[] = [];
  const t = val<number>(lot, "thickness_mm");
  const w = val<number>(lot, "width_mm");
  for (const id of FACT_IDS) {
    const c = checks.find((x) => x.id === id);
    if (!c || id === "width") continue; // width is shown together with thickness
    if (id === "grade") out.push({ ok: c.status === "pass", text: [val<string>(lot, "grade_raw"), standardText(lot)].filter(Boolean).join(" · ") });
    else if (id === "thickness") out.push({ ok: c.status === "pass" && checks.find((x) => x.id === "width")?.status === "pass", text: `${t === null ? "?" : num(t)} × ${w === null ? "?" : num(w)} mm` });
    else if (id === "quantity") out.push({ ok: c.status === "pass" || c.status === "conditional", text: c.detail.replace(" within ", " in ") });
    else if (id === "available_date") out.push({ ok: c.status === "pass", text: demand.need_by && val<string>(lot, "available_from") ? `Ready ${fmtDay(val<string>(lot, "available_from")!)}, need by ${fmtDay(demand.need_by)}` : c.detail });
    else if (id === "certificates") out.push({ ok: c.status === "pass", text: demand.must_have_certificates.length === 0 ? "No certificate required" : c.basis === "seller_claim" ? `${demand.must_have_certificates.join(", ")}: seller's claim` : c.detail });
  }
  return out.filter((f) => f.text);
}

export async function buildDigest(db: Db, actor: Actor, now: Date): Promise<Digest> {
  const ctx = await loadContext(db, actor, now);
  const deals = await openDealsOf(db, actor.network_id);
  const dealPairs = new Set(deals.map((d) => `${d.demand_id}|${d.lot_id}`));
  const demandTitle = (id: string) => ctx.demands.get(id)?.data.title ?? "a demand";

  const risks: Suggestion[] = [];
  for (const d of deals) {
    const pair = pairState(ctx, actor, d.demand_id, d.lot_id);
    const r = dealRisk(d, pair, ctx);
    if (!r || !pair.lot) continue;
    const seller = cap(pair.sellerLabel);
    risks.push({
      lotRef: lotRef(pair.lot, d.lot_id),
      seller,
      sub: `${lotRef(pair.lot, d.lot_id)} · ${seller} · ${lower(r.badge)}`,
      button: RISK_BUTTON[r.action],
      where: whereOf(pair.lot),
      destination: findPlace(ctx.demands.get(d.demand_id)?.data.destination),
      key: `deal:${d.id}:${r.action}`,
      section: "risk",
      action: r.action,
      title: lotTitle(pair.lot),
      ref: `Lot ${lotRef(pair.lot, d.lot_id)} · ${cap(pair.sellerLabel)} · ${STAGE_LABEL[d.stage]}`,
      href: `/deals/${d.id}`,
      status: null,
      badge: r.badge,
      reason: r.reason,
      facts: [],
      draft: r.draft,
      label: r.label,
      priority: null,
      question: null,
      oppId: pair.opp?.id ?? null,
      dealId: d.id,
    });
  }

  const forward: Suggestion[] = [];
  const ask: Suggestion[] = [];
  const engineering: Digest["engineering"] = [];
  const missing: Digest["missing"] = [];
  for (const o of ctx.opps) {
    if (o.status !== "discovered" && o.status !== "under_review") continue;
    if (dealPairs.has(`${o.demand_id}|${o.lot_id}`)) continue;
    const pair = pairState(ctx, actor, o.demand_id, o.lot_id);
    const demand = ctx.demands.get(o.demand_id)?.data;
    if (!pair.lot || !demand) continue;
    const status = o.compatibility_status as CompatibilityStatus;
    const ref = `Lot ${lotRef(pair.lot, o.lot_id)} · ${cap(pair.sellerLabel)} · for "${demandTitle(o.demand_id)}"`;
    const where = whereOf(pair.lot);
    const short = lotRef(pair.lot, o.lot_id);
    const seller = cap(pair.sellerLabel);
    const base = {
      title: lotTitle(pair.lot),
      ref,
      href: `/opportunities/${o.id}`,
      status,
      oppId: o.id,
      dealId: null,
      priority: o.score?.observed == null ? null : Math.round(o.score.observed),
      lotRef: short,
      seller,
      where,
      destination: findPlace(demand.destination),
    };
    if (REVIEWABLE.includes(status)) {
      forward.push({
        ...base,
        key: `opp:${o.id}:shortlist`,
        section: "forward",
        action: "shortlist",
        badge: null,
        reason: status === "declared_match" ? "Every hard requirement passes on the seller's stated values." : "Every hard requirement passes.",
        facts: facts(o.checks, demand, pair.lot),
        draft: quoteRequestDraft(pair.lot, o.lot_id, demand, pair.own, o.checks),
        label: "shortlist and request a quote",
        question: null,
        sub: `${short} · ${seller} · ${where?.terms ?? where?.name ?? "location not shared"}`,
        button: "Shortlist + ask quote",
      });
    } else if (status === "engineering_review_required") {
      const c = o.checks.find((x) => x.status === "review");
      engineering.push({ key: `opp:${o.id}`, lotRef: short, title: base.title, text: c ? c.detail.split(".")[0] : "Different grade or standard", href: base.href, where });
    } else if (status === "insufficient_evidence") {
      // Up to two facts the seller can settle in one message; more, or ones only the buyer can settle, wait in a list.
      const unknown = o.checks.filter((c) => c.status === "unknown");
      const questions = unknown.map((c) => questionFor(c, demand, pair.lot!));
      if (unknown.length <= 2 && questions.every((q) => q !== null)) {
        const question = questions.length === 1 ? questions[0]! : questions.map((q, i) => `${i + 1}) ${cap(q!)}`).join(" ");
        ask.push({
          ...base,
          key: `opp:${o.id}:ask`,
          section: "ask",
          action: "ask",
          badge: null,
          reason: `Everything else passes. Open: ${unknown.map((c) => lower(c.detail)).join("; ")}.`,
          facts: [],
          draft: askDraft(pair.lot, o.lot_id, pair.own, question),
          label: `ask ${pair.own ? "the lot owner" : pair.sellerLabel}`,
          question: cap(question),
          sub: `${short} · ${pair.own ? "your stock" : (where?.name ?? seller)} · ask: ${unknown.map((c) => topicFor(c, demand, pair.lot!)).join(", ")}?`,
          button: pair.own ? "Ask owner" : "Ask seller",
        });
      } else {
        missing.push({ key: `opp:${o.id}`, lotRef: short, title: base.title, text: `${unknown.length} facts open: ${unknown.map((c) => c.label.toLowerCase()).join(", ")}`, href: base.href, where });
      }
    }
  }
  forward.sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1));

  // Lots that fail a hard requirement for every demand they were checked against.
  const liveLots = new Set(ctx.opps.filter((o) => o.status !== "invalidated").map((o) => o.lot_id));
  const ruledOut = new Map<string, DigestItem>();
  for (const r of ctx.rejected) {
    if (liveLots.has(r.lot_id) || ruledOut.has(r.lot_id)) continue;
    const v = ctx.visible.get(r.lot_id);
    const fail = r.checks.find((c) => c.status === "fail");
    if (!v || !fail) continue;
    const lot = projectLot(v.lot.data, v.access);
    ruledOut.set(r.lot_id, { key: `lot:${r.lot_id}`, lotRef: lotRef(lot, r.lot_id), title: lotTitle(lot), text: cap(lower(fail.detail)), href: null, where: whereOf(lot) });
  }

  const own = [...ctx.visible.values()].filter((v) => v.access.own);
  return {
    now,
    hasDemands: [...ctx.demands.values()].some((d) => d.status === "active"),
    stats: { lots: ctx.visible.size, candidates: forward.length + ask.length, deals: deals.length, ruledOut: ruledOut.size },
    risks,
    forward,
    ask,
    engineering,
    missing,
    ruledOut: [...ruledOut.values()],
    staleOwnLots: own.filter((v) => stockAgeHours(v.lot.data, now) > FRESHNESS_WINDOW_HOURS).length,
  };
}

export const allSuggestions = (d: Digest) => [...d.risks, ...d.forward, ...d.ask];

/**
 * Runs the given suggestions if they still exist on a freshly computed digest.
 * Returns how many ran; the rest no longer applied.
 */
export async function acceptSuggestions(db: Db, actor: Actor, keys: string[], now: Date) {
  const digest = await buildDigest(db, actor, now);
  const byKey = new Map(allSuggestions(digest).map((s) => [s.key, s]));
  let done = 0;
  for (const key of keys) {
    const s = byKey.get(key);
    if (!s) continue;
    await runSuggestion(db, actor, s, now);
    done++;
  }
  return { done, skipped: keys.length - done };
}

async function runSuggestion(db: Db, actor: Actor, s: Suggestion, now: Date) {
  const today = isoDay(now);
  if (s.action === "shortlist") {
    await decideOpportunity(db, actor, s.oppId!, "shortlisted", "Daily digest: every hard requirement passes", now);
    await startDeal(db, actor, s.oppId!, "quote_requested", null, "Shortlisted from the digest; quote requested (send the drafted message yourself)", now);
    return;
  }
  if (s.action === "ask") {
    await decideOpportunity(db, actor, s.oppId!, "information_requested", `Daily digest: asked "${s.question}"`, now);
    await startDeal(db, actor, s.oppId!, "waiting", s.question, `Asked: ${s.question}`, now);
    return;
  }
  const deal = await getDealForBuyer(db, actor, s.dealId!);
  await db.transaction(async (tx) => {
    switch (s.action) {
      case "reconfirm":
        await update(tx, deal, { snoozed_until: addDays(today, 1), follow_up_on: addDays(today, 1) }, now);
        await event(tx, deal.id, actor.id, "asked", "Asked the seller to reconfirm the stock", now);
        break;
      case "follow_up":
        await update(tx, deal, { follow_up_on: addDays(today, FOLLOW_UP_DAYS) }, now);
        await event(tx, deal.id, actor.id, "asked", "Followed up with the seller", now);
        break;
      case "requote":
        await update(tx, deal, { stage: "quote_requested", follow_up_on: addDays(today, FOLLOW_UP_DAYS) }, now);
        await event(tx, deal.id, actor.id, "quote_requested", "Asked whether the expired offer still stands", now);
        break;
      case "request_quote":
        await update(tx, deal, { stage: "quote_requested", ask: null, follow_up_on: addDays(today, FOLLOW_UP_DAYS) }, now);
        await event(tx, deal.id, actor.id, "quote_requested", "Answer received; quote requested", now);
        break;
      case "review_change":
        await update(tx, deal, { snoozed_until: addDays(today, 1) }, now);
        await event(tx, deal.id, actor.id, "reviewed", "Reviewed the changed assessment", now);
        break;
      case "close_lost":
        await update(tx, deal, { stage: "lost", closed_reason: s.reason, follow_up_on: null }, now);
        await event(tx, deal.id, actor.id, "closed", `Closed as lost: ${s.reason}`, now);
        break;
    }
  });
}

/** "Dismiss" on a candidate, "Not now" on a deal risk. */
export async function declineSuggestion(db: Db, actor: Actor, key: string, now: Date) {
  const digest = await buildDigest(db, actor, now);
  const s = allSuggestions(digest).find((x) => x.key === key);
  if (!s) return false;
  if (s.dealId) {
    const deal = await getDealForBuyer(db, actor, s.dealId);
    await db.transaction(async (tx) => {
      await update(tx, deal, { snoozed_until: addDays(isoDay(now), 1) }, now);
      await event(tx, deal.id, actor.id, "snoozed", `Not now: ${s.badge ?? s.label}`, now);
    });
  } else await decideOpportunity(db, actor, s.oppId!, "dismissed", "Dismissed from the daily digest", now);
  return true;
}

// --- deals pages ------------------------------------------------------------------------

export interface DealCard {
  deal: DealRow;
  title: string;
  ref: string;
  risk: Risk | null;
  next: string;
}

export async function listDealsForActor(db: Db, actor: Actor, now: Date): Promise<DealCard[]> {
  const ctx = await loadContext(db, actor, now);
  const deals = await db.query<DealRow>(`SELECT ${DEAL_COLS} FROM deals WHERE buyer_network_id = $1 ORDER BY updated_at DESC`, [actor.network_id]);
  return deals.map((d) => {
    const pair = pairState(ctx, actor, d.demand_id, d.lot_id);
    const open = OPEN_STAGES.includes(d.stage);
    const risk = open ? dealRisk(d, pair, ctx) : null;
    return {
      deal: d,
      // Lot values only while the buyer may still see the lot.
      title: pair.lot ? lotTitle(pair.lot) : "Lot details hidden",
      ref: pair.lot ? `${lotRef(pair.lot, d.lot_id)} · ${cap(pair.sellerLabel)}` : `${cap(pair.sellerLabel)} · access ended`,
      risk,
      next: risk ? `Next: ${risk.label}` : nextStep(d),
    };
  });
}

function nextStep(d: DealRow) {
  switch (d.stage) {
    case "waiting":
      return d.ask ? `Asked: ${d.ask}` : "Waiting for an answer";
    case "quote_requested":
      return "Next: wait for the offer";
    case "quote_in_hand":
      return d.quote ? `Offer ${d.quote.currency} ${d.quote.price}/MT ${d.quote.incoterm}` : "Offer recorded";
    case "negotiating":
      return d.quote ? `Last offer ${d.quote.currency} ${d.quote.price}/MT` : "Negotiating";
    default:
      return d.closed_reason ?? STAGE_LABEL[d.stage];
  }
}

export interface DealView {
  deal: DealRow;
  demand: Demand;
  lot: InventoryLot | null;
  title: string;
  ref: string;
  sellerLabel: string;
  risk: Risk | null;
  /** Current opportunity view (checks, score), when one is open. */
  view: OpportunityView | null;
  compatibility: CompatibilityStatus | null;
  watch: { label: string; value: string; tone: "ok" | "warn" | "muted" }[];
  events: { kind: string; note: string; created_at: Date; actor_id: string | null }[];
  budgetNote: string | null;
}

export async function getDealViewForActor(db: Db, actor: Actor, id: string, now: Date): Promise<DealView> {
  await getDealForBuyer(db, actor, id); // not found before any work
  const ctx = await loadContext(db, actor, now);
  const deal = await getDealForBuyer(db, actor, id); // after auto-close
  const pair = pairState(ctx, actor, deal.demand_id, deal.lot_id);
  const demand = (await db.query<{ data: Demand }>(`SELECT v.data FROM demands d JOIN demand_versions v ON v.demand_id = d.id AND v.version = d.current_version WHERE d.id = $1`, [deal.demand_id]))[0].data;
  const view = pair.opp ? await getOpportunityForActor(db, actor, pair.opp.id, now) : null;
  const open = OPEN_STAGES.includes(deal.stage);
  const lotRow = (await db.query<{ current_version: number }>(`SELECT current_version FROM lots WHERE id = $1`, [deal.lot_id]))[0];
  const compatibility = pair.opp?.compatibility_status ?? (pair.fails.length ? "incompatible" : null);

  const watch: DealView["watch"] = [];
  if (pair.lot) {
    const age = Math.round(stockAgeHours(pair.lot, now));
    watch.push({ label: "Stock confirmation", value: `${age} h`, tone: age > FRESHNESS_WINDOW_HOURS ? "warn" : "ok" });
    watch.push({
      label: "Hard requirements",
      value: compatibility && REVIEWABLE.includes(compatibility) ? "All pass" : compatibility === "incompatible" ? "One fails" : "Open questions",
      tone: compatibility && REVIEWABLE.includes(compatibility) ? "ok" : "warn",
    });
    watch.push({ label: "Lot since start", value: lotRow.current_version === deal.lot_version_at_start ? "Unchanged" : "Updated by owner", tone: lotRow.current_version === deal.lot_version_at_start ? "ok" : "muted" });
  }
  watch.push({ label: "Sharing", value: pair.own ? "Your network" : pair.lot ? "Active" : "Ended", tone: pair.lot ? "ok" : "warn" });

  let budgetNote: string | null = null;
  const b = demand.budget;
  if (b && deal.quote) {
    const same = b.currency === deal.quote.currency && b.incoterm.toUpperCase() === deal.quote.incoterm.split(" ")[0].toUpperCase();
    budgetNote = same
      ? compareDecimal(deal.quote.price, b.amount) <= 0
        ? `Within your budget of ${b.currency} ${b.amount}/MT ${b.incoterm} ${b.place} (goods only).`
        : `Over your budget of ${b.currency} ${b.amount}/MT ${b.incoterm} ${b.place}.`
      : `Budget ${b.currency} ${b.amount}/MT ${b.incoterm} ${b.place}; different terms, so not compared.`;
  } else if (b) budgetNote = `Your budget: ${b.currency} ${b.amount}/MT ${b.incoterm} ${b.place} (goods only).`;

  return {
    deal,
    demand,
    lot: pair.lot,
    title: pair.lot ? lotTitle(pair.lot) : "Lot details hidden",
    ref: `Lot ${lotRef(pair.lot, deal.lot_id)} · ${cap(pair.sellerLabel)} · for "${demand.title}"`,
    sellerLabel: pair.own ? "the lot owner" : pair.sellerLabel,
    risk: open ? dealRisk(deal, pair, ctx) : null,
    view,
    compatibility,
    watch,
    events: await db.query(`SELECT kind, note, created_at, actor_id FROM deal_events WHERE deal_id = $1 ORDER BY created_at DESC, id DESC`, [deal.id]),
    budgetNote,
  };
}

/** The seller's message drafted for the deal's current risk or next step. */
export function dealDraft(v: DealView): string | null {
  if (v.risk?.draft) return v.risk.draft;
  if (!v.lot) return null;
  if (v.deal.stage === "quote_requested" && v.view) return quoteRequestDraft(v.lot, v.deal.lot_id, v.demand, v.sellerLabel === "the lot owner", v.view.checks);
  if (v.deal.stage === "waiting" && v.deal.ask) return askDraft(v.lot, v.deal.lot_id, v.sellerLabel === "the lot owner", lower(v.deal.ask));
  return null;
}

// --- deal actions --------------------------------------------------------------------

export async function recordQuote(db: Db, actor: Actor, id: string, quote: Quote, now: Date) {
  const deal = await getDealForBuyer(db, actor, id);
  if (!OPEN_STAGES.includes(deal.stage)) throw new ForbiddenError("This deal is closed");
  if (!/^\d+(\.\d+)?$/.test(quote.price)) throw new Error("Enter the price as a number, e.g. 545");
  if (quote.valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(quote.valid_until)) throw new Error("Use YYYY-MM-DD for the validity date");
  await db.transaction(async (tx) => {
    const stage = deal.stage === "negotiating" ? "negotiating" : "quote_in_hand";
    await update(tx, deal, { stage, quote, follow_up_on: null, snoozed_until: null }, now);
    await event(tx, deal.id, actor.id, "quote", `Offer recorded: ${quote.currency} ${quote.price}/MT ${quote.incoterm}${quote.valid_until ? `, valid until ${fmtDay(quote.valid_until)}` : ""}`, now);
  });
}

export async function moveDeal(db: Db, actor: Actor, id: string, to: "quote_requested" | "negotiating", now: Date) {
  const deal = await getDealForBuyer(db, actor, id);
  if (!OPEN_STAGES.includes(deal.stage)) throw new ForbiddenError("This deal is closed");
  if (to === "negotiating" && !deal.quote) throw new ForbiddenError("Record the seller's offer first");
  if (to === "quote_requested") {
    // A quote is requested only on a pair that passes every hard requirement now.
    const v = await getDealViewForActor(db, actor, id, now);
    if (!v.compatibility || !REVIEWABLE.includes(v.compatibility)) throw new ForbiddenError("Settle the open requirements before asking for a quote");
  }
  await db.transaction(async (tx) => {
    await update(tx, deal, { stage: to, ask: to === "quote_requested" ? null : deal.ask, follow_up_on: to === "quote_requested" ? addDays(isoDay(now), FOLLOW_UP_DAYS) : null }, now);
    await event(tx, deal.id, actor.id, to, to === "negotiating" ? "Started negotiating" : "Quote requested", now);
  });
}

export async function closeDeal(db: Db, actor: Actor, id: string, outcome: "won" | "lost", reason: string, now: Date) {
  const why = reason.trim();
  if (!why) throw new Error("Give a reason");
  const deal = await getDealForBuyer(db, actor, id);
  if (!OPEN_STAGES.includes(deal.stage)) throw new ForbiddenError("This deal is already closed");
  if (outcome === "won") {
    // Won only on a recorded offer for a pair that still passes every hard requirement.
    const v = await getDealViewForActor(db, actor, id, now);
    if (!deal.quote) throw new ForbiddenError("Record the seller's offer before closing as won");
    if (!v.lot || !v.compatibility || !REVIEWABLE.includes(v.compatibility)) throw new ForbiddenError("The lot no longer passes every hard requirement");
  }
  await db.transaction(async (tx) => {
    await update(tx, deal, { stage: outcome, closed_reason: why, follow_up_on: null }, now);
    await event(tx, deal.id, actor.id, "closed", `Closed as ${outcome}: ${why}`, now);
    await audit(tx, actor.id, `deal.${outcome}`, "deal", deal.id, { reason: why });
  });
}
