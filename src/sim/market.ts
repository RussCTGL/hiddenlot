import { readFileSync } from "node:fs";
import path from "node:path";
import { hashPassword } from "@/auth/accounts";
import type { Actor } from "@/auth/access";
import type { Db, Sql } from "@/db/client";
import { getLot } from "@/db/repo";
import type { Check } from "@/discovery/constraints";
import type { Demand, InventoryLot, InventoryLotField } from "@/domain/hrc";
import { intakeDocument } from "@/ingestion/intake";
import { canonicalExtractor, type CanonicalDocument, type CanonicalLot } from "@/seed/canonical";
import { ALL_LOT_FIELDS, createDemand, createGrant, publishLot, reconfirmLot, reviewLot, setLotStatus, withdrawDemand, type DemandInput, type FieldEdit } from "@/workflow/actions";

// The simulated market: pseudo users who use HiddenLot the way real members
// would, so the public demo keeps moving. Each tick, driven by a seeded
// random sequence, some of them
//   - post a stock list (text or CSV) through the real intake, review and publish it;
//   - post a demand, often for something a partner network has in stock;
//   - answer a buyer's open question by correcting their own lot;
//   - sell a lot.
// Documents carry their own truth, so extraction is scripted like the demo
// seed (no model calls) and still passes every evidence check. Nothing here
// goes around the rules: every change is an ordinary action by the pseudo user.

export const MARKET_DIR = path.join(process.cwd(), "data", "synthetic", "market");

interface Seller {
  user: string;
  prefix: string;
  style: "text_bilingual" | "text_imperial" | "csv";
  units: "metric" | "imperial";
  places: string[];
  grades: [string, string][];
  terms: [string, string][];
  currency: string;
  price: [number, number];
}
interface Buyer {
  user: string;
  destinations: string[];
  grades: [string, string][];
  currency: string;
  budget: [number, number];
}
interface MarketUser {
  id: string;
  network_id: string;
  username: string;
  name: string;
  role: "trader" | "reviewer";
}
export interface Market {
  dataset: string;
  version: string;
  demo_password: string;
  accounts: Record<string, string>;
  networks: { id: string; name: string; alias: string; region: string }[];
  users: MarketUser[];
  grants: { id: string; owner_network_id: string; recipient_network_id: string; created_by: string }[];
  sellers: Seller[];
  buyers: Buyer[];
  sizes_mm: [number, number][];
}

export function loadMarket(): Market {
  return JSON.parse(readFileSync(path.join(MARKET_DIR, "market.json"), "utf8")) as Market;
}

/** Sign-in accounts for the story users, plus the pseudo users and their network and grants. Runs inside the demo seed. */
export async function seedMarket(db: Db, now: Date): Promise<void> {
  const m = loadMarket();
  for (const n of m.networks) await db.query(`INSERT INTO networks (id, name, alias, region, synthetic) VALUES ($1,$2,$3,$4,true)`, [n.id, n.name, n.alias, n.region]);
  for (const u of m.users) {
    await db.query(`INSERT INTO users (id, network_id, name, role, synthetic, username, password_hash, simulated) VALUES ($1,$2,$3,$4,true,$5,$6,true)`, [
      u.id,
      u.network_id,
      u.name,
      u.role,
      u.username,
      await hashPassword(m.demo_password),
    ]);
  }
  for (const [id, username] of Object.entries(m.accounts)) {
    await db.query(`UPDATE users SET username = $2, password_hash = $3 WHERE id = $1`, [id, username, await hashPassword(m.demo_password)]);
  }
  for (const g of m.grants) {
    const by = await actorOf(db, g.created_by);
    await createGrant(db, by, { recipient_network_id: g.recipient_network_id, lot_id: null, field_scope: ALL_LOT_FIELDS, allow_identity_disclosure: false, allow_model_processing: true, expires_at: null }, now, g.id);
  }
  await db.query(`INSERT INTO market_state (id, ticks, last_tick) VALUES (1, 0, NULL) ON CONFLICT (id) DO UPDATE SET ticks = 0, last_tick = NULL`);
}

// --- one tick ------------------------------------------------------------------

export interface TickReport {
  tick: number;
  events: { kind: string; network_id: string; summary: string }[];
}

/** One step of simulated activity. Deterministic for a given database state and tick number. */
export async function runMarketTick(db: Db, now: Date): Promise<TickReport> {
  const m = loadMarket();
  const state = (await db.query<{ ticks: number }>(`SELECT ticks FROM market_state WHERE id = 1`))[0];
  if (!state) throw new Error("The market is not seeded");
  const tick = state.ticks + 1;
  const rnd = rng(tick * 7919 + 17);
  const report: TickReport = { tick, events: [] };
  const log = async (actor: Actor, kind: string, owner: string, shared: string | null) => {
    await db.query(`INSERT INTO market_events (at, network_id, actor_id, kind, owner_summary, shared_summary) VALUES ($1,$2,$3,$4,$5,$6)`, [now.toISOString(), actor.network_id, actor.id, kind, owner, shared]);
    report.events.push({ kind, network_id: actor.network_id, summary: owner });
  };

  await answerQuestions(db, m, rnd, now, log);
  if (rnd() < 0.6) await postStock(db, m, pick(rnd, m.sellers), tick, rnd, now, log);
  if (rnd() < 0.4) await postDemand(db, m, pick(rnd, m.buyers), tick, rnd, now, log);
  if (rnd() < 0.15) await sellSomething(db, m, rnd, now, log);

  await db.query(`UPDATE market_state SET ticks = $1, last_tick = $2 WHERE id = 1`, [tick, now.toISOString()]);
  return report;
}

type Log = (actor: Actor, kind: string, owner: string, shared: string | null) => Promise<void>;

// --- sellers -----------------------------------------------------------------------

interface LotSpec {
  ref: string;
  grade: string;
  standard: string;
  thickness_mm: number;
  width_mm: number;
  kg: number;
  coils: number;
  place: string;
  incoterm: string;
  incoterm_place: string;
  price: number;
  currency: string;
  mtc: boolean;
  prime: boolean;
  from: string;
}

const MAX_LIVE_LOTS = 10; // per seller network, from the simulator
const MAX_LIVE_DEMANDS = 4; // per buyer network, from the simulator

async function postStock(db: Db, m: Market, seller: Seller, tick: number, rnd: () => number, now: Date, log: Log) {
  const actor = await actorOf(db, seller.user);
  // Often the seller has heard what a partner's buyers want.
  const wanted = await partnerDemands(db, actor.network_id);
  const n = 1 + Math.floor(rnd() * 3);
  const specs: LotSpec[] = [];
  for (let i = 0; i < n; i++) {
    const ref = `${seller.prefix}-${String(tick).padStart(3, "0")}${i + 1}`;
    const aim = wanted.length && rnd() < 0.55 ? pick(rnd, wanted) : null;
    specs.push(aim ? lotFor(aim, seller, ref, rnd, now) : randomLot(m, seller, ref, rnd, now));
  }
  const doc = render(seller, actor, specs, tick);
  const r = await intakeDocument(
    db,
    actor,
    { bytes: new TextEncoder().encode(doc.text), filename: doc.file.file, mime: null, extractor: "market_sim", synthetic: true, lot_ids: specs.map((_, i) => `lot-sim-${tick}-${i + 1}`) },
    canonicalExtractor(doc.file),
    now,
  );
  if (r.status !== "needs_review" || r.lots.length !== specs.length) throw new Error(`market: ${doc.file.file} gave ${r.lots.length}/${specs.length} lots (${r.error ?? r.issues.map((x) => x.code).join(", ")})`);
  for (const lotId of r.lots) {
    const lot = (await getLot(db, lotId))!;
    await reviewLot(db, actor, lotId, lot.current_version, ALL_LOT_FIELDS.map((field) => ({ field, action: "confirm" as const })), now, "simulated seller: reviewed own listing");
    await publishLot(db, actor, lotId, lot.current_version + 1, now);
  }
  await log(
    actor,
    "stock",
    `${firstName(actor)} listed ${n} coil${n > 1 ? "s" : ""}: ${specs.map((s) => `${s.ref} ${s.grade} ${fmt(s.thickness_mm)} × ${s.width_mm}, ${fmt(s.kg / 1000)} t at ${s.place}`).join("; ")}`,
    `${await alias(db, actor.network_id)} listed ${n} new coil${n > 1 ? "s" : ""}`,
  );

  // Older simulated stock leaves the list, as it does in practice.
  const live = await db.query<{ id: string; current_version: number }>(
    `SELECT id, current_version FROM lots WHERE owner_network_id = $1 AND status = 'published' AND id LIKE 'lot-sim-%' ORDER BY created_at, id`,
    [actor.network_id],
  );
  for (const old of live.slice(0, Math.max(0, live.length - MAX_LIVE_LOTS))) {
    await setLotStatus(db, actor, old.id, old.current_version, "withdrawn", now);
    await log(actor, "withdrawn", `${firstName(actor)} took ${await lotRef(db, old.id)} off the list`, null);
  }
}

/** A lot cut for a partner's demand, usually fitting, sometimes off in one way, sometimes missing a fact. */
function lotFor(d: Demand, seller: Seller, ref: string, rnd: () => number, now: Date): LotSpec {
  const own = seller.grades.find(([g]) => d.accepted_grades.some((a) => a.grade === g));
  const [grade, standard] = own ?? pick(rnd, seller.grades);
  const term = d.destination ? (["CFR", d.destination] as [string, string]) : pick(rnd, seller.terms);
  const target = d.quantity_kg.target ?? (d.quantity_kg.min + d.quantity_kg.max) / 2;
  const spec: LotSpec = {
    ref,
    grade,
    standard,
    thickness_mm: mid(d.thickness_mm.min, d.thickness_mm.max, 3.0),
    width_mm: Math.round(mid(d.width_mm.min, d.width_mm.max, 1500)),
    // Somewhere in the buyer's range, not always the target.
    kg: Math.round(Math.min(Math.max(target * (0.9 + rnd() * 0.2), d.quantity_kg.min), d.quantity_kg.max) / 100) * 100,
    coils: 1,
    place: pick(rnd, seller.places),
    incoterm: term[0],
    incoterm_place: term[1],
    price: d.budget ? Number(d.budget.amount) - 5 - Math.floor(rnd() * 25) : between(rnd, seller.price),
    currency: d.budget?.currency ?? seller.currency,
    mtc: rnd() > 0.3,
    prime: rnd() > 0.25,
    from: day(now, 2 + Math.floor(rnd() * 10)),
  };
  // Some near misses: a near size or a short quantity.
  const miss = rnd();
  if (miss < 0.12) spec.width_mm += 30;
  else if (miss < 0.22) spec.kg = Math.round((d.quantity_kg.min * 0.6) / 100) * 100;
  return spec;
}

function randomLot(m: Market, seller: Seller, ref: string, rnd: () => number, now: Date): LotSpec {
  const [grade, standard] = pick(rnd, seller.grades);
  const [t, w] = pick(rnd, m.sizes_mm);
  const [incoterm, incoterm_place] = pick(rnd, seller.terms);
  return {
    ref,
    grade,
    standard,
    thickness_mm: t,
    width_mm: w,
    kg: 12_000 + Math.round(rnd() * 140) * 100,
    coils: rnd() < 0.8 ? 1 : 2,
    place: pick(rnd, seller.places),
    incoterm,
    incoterm_place,
    price: between(rnd, seller.price),
    currency: seller.currency,
    mtc: rnd() > 0.3,
    prime: rnd() > 0.25,
    from: day(now, 1 + Math.floor(rnd() * 14)),
  };
}

// --- rendering: the document a seller would actually paste, with its truth ---------

type Truth = CanonicalLot["fields"];

function render(seller: Seller, actor: Actor, specs: LotSpec[], tick: number): { text: string; file: CanonicalDocument } {
  const base = { id: `doc-sim-${tick}`, network_id: actor.network_id, uploaded_by: actor.id };
  if (seller.style === "csv") {
    const header = ["Lot", "Product", "Grade", "Standard", "Thickness (mm)", "Width (mm)", "Weight (MT)", "Coils", "Condition", "Certificates", "Location", "Available from", "Price"];
    const lines = ["SYNTHETIC MARKET DATA — simulated stock list, not a real offer", header.join(",")];
    const lots: CanonicalLot[] = specs.map((s) => {
      const price = `${s.currency} ${s.price}/MT ${s.incoterm} ${s.incoterm_place}`;
      const t = fmt(s.thickness_mm);
      const tn = fmt(s.kg / 1000);
      lines.push([s.ref, "HRC", s.grade, s.standard, t, s.width_mm, tn, s.coils, s.prime ? "prime" : "", s.mtc ? "MTC" : "", s.place, s.from, price].join(","));
      const fields: Truth = {
        seller_lot_ref: [s.ref, `Lot: ${s.ref}`],
        product_form: ["hot_rolled_coil", "Product: HRC"],
        grade: [s.grade, `Grade: ${s.grade}`],
        standard_id: [s.standard, `Standard: ${s.standard}`],
        thickness: [s.thickness_mm, `Thickness (mm): ${t}`, "mm"],
        width: [s.width_mm, `Width (mm): ${s.width_mm}`, "mm"],
        total_weight: [Number(tn), `Weight (MT): ${tn}`, "MT"],
        piece_count: [s.coils, `Coils: ${s.coils}`],
        location_place: [s.place, `Location: ${s.place}`],
        available_from: [s.from, `Available from: ${s.from}`],
        price_amount: [String(s.price), `Price: ${price}`],
        price_currency: [s.currency, `Price: ${price}`],
        price_basis: ["per_mt", `Price: ${price}`],
        incoterm: [s.incoterm, `Price: ${price}`],
        incoterm_place: [s.incoterm_place, `Price: ${price}`],
      };
      if (s.prime) fields.condition = ["prime", "Condition: prime"];
      if (s.mtc) fields.certificate_claims = [["MTC"], "Certificates: MTC"];
      return { lot_id: "", anchor: s.ref, fields };
    });
    return { text: lines.join("\n") + "\n", file: { ...base, kind: "csv", file: `market-${seller.prefix.toLowerCase()}-${tick}.csv`, lots } };
  }

  const imperial = seller.units === "imperial";
  const lines = imperial
    ? ["[SYNTHETIC MARKET DATA — simulated stockist, not a real offer]", `From: ${firstName(actor)}, stock desk (simulated)`, "Surplus list — HRC", ""]
    : ["[SYNTHETIC MARKET DATA — simulated trader, not a real offer / 模拟数据，非真实报价]", `From: ${firstName(actor)}, stock desk (simulated)`, "现货出清 Stock clearance — HRC 热轧卷", ""];
  const lots: CanonicalLot[] = specs.map((s, i) => {
    const heat = `H${26 + (i % 2)}-${String(10000 + ((s.ref.length * 7919 + i * 104729 + s.width_mm) % 89999)).padStart(5, "0")}`;
    const priceLine = `${s.currency} ${s.price} / MT ${s.incoterm} ${s.incoterm_place}`;
    const coils = `${s.coils} coil${s.coils > 1 ? "s" : ""}`;
    const fields: Truth = {
      seller_lot_ref: [s.ref, s.ref],
      product_form: ["hot_rolled_coil", "HRC"],
      grade: [s.grade, s.grade],
      standard_id: [s.standard, s.standard],
      piece_count: [s.coils, coils],
      location_place: [s.place, s.place],
      available_from: [s.from, s.from],
      price_amount: [String(s.price), `${s.currency} ${s.price} / MT`],
      price_currency: [s.currency, `${s.currency} ${s.price}`],
      price_basis: ["per_mt", `${s.price} / MT`],
      incoterm: [s.incoterm, `${s.incoterm} ${s.incoterm_place}`],
      incoterm_place: [s.incoterm_place, `${s.incoterm} ${s.incoterm_place}`],
    };
    lines.push(`Lot ${s.ref}`);
    if (imperial) {
      const tIn = Math.round((s.thickness_mm / 25.4) * 1000) / 1000;
      const wIn = Math.round(s.width_mm / 25.4);
      const lbs = Math.round(s.kg / 0.45359237);
      const lbsText = lbs.toLocaleString("en-US");
      lines.push(`Grade: ${s.grade} (${s.standard}, edition not stated)`, `Size: ${tIn} in x ${wIn} in, ${coils}`, `Weight: ${lbsText} lbs`);
      fields.thickness = [tIn, `${tIn} in`, "in"];
      fields.width = [wIn, `${wIn} in`, "in"];
      fields.total_weight = [lbs, `${lbsText} lbs`, "lbs"];
      if (s.prime) {
        lines.push("Condition: prime");
        fields.condition = ["prime", "Condition: prime"];
      }
      lines.push(`Location: ${s.place}`);
    } else {
      const t = fmt(s.thickness_mm);
      const tn = fmt(s.kg / 1000);
      lines.push(`牌号 Grade: ${s.grade} (${s.standard}, edition not stated)`, `规格 Size: ${t}mm x ${s.width_mm}mm x C`, `重量 Weight: ${tn} MT, ${coils} / ${s.coils}卷`);
      fields.thickness = [s.thickness_mm, `${t}mm`, "mm"];
      fields.width = [s.width_mm, `${s.width_mm}mm`, "mm"];
      fields.total_weight = [Number(tn), `${tn} MT`, "MT"];
      if (s.prime) {
        lines.push("质量 Quality: prime / 正品");
        fields.condition = ["prime", "prime"];
      }
      lines.push(`库存地点 Location: ${s.place}`);
    }
    if (s.mtc) {
      lines.push(`MTC available, heat no. ${heat}`);
      fields.certificate_claims = [["MTC"], "MTC available"];
      fields.heat_numbers = [[heat], heat];
    }
    lines.push(imperial ? `Available from ${s.from}` : `可提货 Available from ${s.from}`, imperial ? `Price: ${priceLine}` : `价格 Price: ${priceLine}`, "");
    return { lot_id: "", anchor: `Lot ${s.ref}`, fields };
  });
  return { text: lines.join("\n"), file: { ...base, kind: "text", file: `market-${seller.prefix.toLowerCase()}-${tick}.txt`, lots } };
}

// --- buyers --------------------------------------------------------------------------

async function postDemand(db: Db, m: Market, buyer: Buyer, tick: number, rnd: () => number, now: Date, log: Log) {
  const actor = await actorOf(db, buyer.user);
  const destination = pick(rnd, buyer.destinations);
  // Often a buyer asks for something like what a partner listed; otherwise for a common size.
  const seen = await db.query<{ data: InventoryLot }>(
    `SELECT v.data FROM lots l JOIN lot_versions v ON v.lot_id = l.id AND v.version = l.current_version
      WHERE l.status = 'published' AND l.owner_network_id IN
            (SELECT owner_network_id FROM sharing_grants WHERE recipient_network_id = $1 AND revoked_at IS NULL AND allow_discovery)
      ORDER BY l.id`,
    [actor.network_id],
  );
  const like = seen.length && rnd() < 0.5 ? pick(rnd, seen).data : null;
  const thickness = (like && val<number>(like, "thickness_mm")) ?? pick(rnd, m.sizes_mm)[0];
  const width = (like && val<number>(like, "width_mm")) ?? pick(rnd, m.sizes_mm)[1];
  const grade = buyer.grades.find(([g]) => g === (like && val<string>(like, "grade_raw"))) ?? pick(rnd, buyer.grades);
  const target = Math.round(((like && val<number>(like, "total_kg")) ?? 14_000 + rnd() * 10_000) / 1000) * 1000;
  const budget = between(rnd, buyer.budget);
  const input: DemandInput = {
    title: `HRC ${grade[0]} ${fmt(thickness)} × ${Math.round(width)}, ${Math.round((target * 0.85) / 1000)}–${Math.round((target * 1.15) / 1000)} t, CFR ${destination}`,
    product_form: "hot_rolled_coil",
    quantity_kg: { min: Math.round(target * 0.85), target, max: Math.round(target * 1.15) },
    thickness_mm: { min: round2(thickness - 0.05), max: round2(thickness + 0.05), source: "buyer_explicit" },
    width_mm: { min: Math.round(width - 5), max: Math.round(width + 5), source: "buyer_explicit" },
    accepted_grades: [{ grade: grade[0], standard_id: grade[1], edition: null }],
    substitution_policy: "review_required",
    acceptable_conditions: ["prime"],
    must_have_certificates: ["MTC"],
    allow_partial_delivery: false,
    allow_multi_lot: false,
    destination,
    need_by: day(now, 14 + Math.floor(rnd() * 21)),
    budget: { amount: String(budget), currency: buyer.currency, basis: "per_mt", incoterm: "CFR", place: destination },
    expires_at: null,
  } as DemandInput;
  await createDemand(db, actor, input, now, `dem-sim-${tick}`);
  await log(actor, "demand", `${firstName(actor)} posted a demand: ${input.title}, budget ${buyer.currency} ${budget}/MT`, null);

  const live = await db.query<{ id: string }>(`SELECT id FROM demands WHERE buyer_network_id = $1 AND status = 'active' AND id LIKE 'dem-sim-%' ORDER BY created_at, id`, [actor.network_id]);
  for (const old of live.slice(0, Math.max(0, live.length - MAX_LIVE_DEMANDS))) {
    await withdrawDemand(db, actor, old.id, now);
    await log(actor, "demand_closed", `${firstName(actor)} closed an older demand`, null);
  }
}

// --- answers -------------------------------------------------------------------------

// Editions a seller states when asked; fictional sellers, real standard numbers.
const EDITIONS: Record<string, string> = {
  "JIS G3101": "2020",
  "GB/T 700": "2006",
  "KS D3503": "2018",
  "ASTM A1011": "A1011/A1011M-23",
  "EN 10025-2": "2019",
  "GB/T 1591": "2018",
};

/**
 * A buyer who is waiting on a seller's answer gets one: the simulated stock
 * desk of the selling network corrects its own lot, which re-runs discovery
 * and flags the buyer's deal as changed. Questions the seller cannot answer
 * from its own records (a size, a withheld field) stay open.
 */
async function answerQuestions(db: Db, m: Market, rnd: () => number, now: Date, log: Log) {
  const desks = new Map<string, string>();
  for (const u of m.users) if (m.sellers.some((s) => s.user === u.id)) desks.set(u.network_id, u.id);
  const waiting = await db.query<{ lot_id: string; demand_id: string; owner: string }>(
    `SELECT DISTINCT dl.lot_id, dl.demand_id, l.owner_network_id AS owner
       FROM deals dl JOIN lots l ON l.id = dl.lot_id
      WHERE dl.stage = 'waiting' AND l.status = 'published'
      ORDER BY dl.lot_id, dl.demand_id`,
  );
  const answered = new Set<string>();
  for (const w of waiting) {
    const desk = desks.get(w.owner);
    if (!desk || answered.has(w.lot_id) || rnd() > 0.6) continue;
    const checks = await currentChecks(db, w.lot_id, w.demand_id);
    const lot = (await getLot(db, w.lot_id))!;
    const demand = (await db.query<{ data: Demand }>(`SELECT v.data FROM demands d JOIN demand_versions v ON v.demand_id = d.id AND v.version = d.current_version WHERE d.id = $1`, [w.demand_id]))[0]?.data;
    if (!demand) continue;
    const actor = await actorOf(db, desk);
    const edits: FieldEdit[] = [];
    const said: string[] = [];
    let reconfirm = false;
    for (const c of checks.filter((x) => x.status === "unknown" && x.ask === "seller" && !x.detail.startsWith("Not shared"))) {
      const note = "seller answered a buyer's question (simulated)";
      switch (c.id) {
        case "certificates":
          edits.push({ field: "certificate_claims", action: "correct", value: demand.must_have_certificates, note });
          said.push(`${demand.must_have_certificates.join(", ")} available`);
          break;
        case "condition": {
          const prime = rnd() < 0.8;
          edits.push({ field: "condition", action: "correct", value: prime ? "prime" : "secondary", note });
          if (!prime) edits.push({ field: "defect_notes", action: "correct", value: "edge waves on the outer wraps", note });
          said.push(prime ? "prime" : "secondary, edge waves");
          break;
        }
        case "standard": {
          const std = val<string>(lot.data, "standard_id");
          if (std && EDITIONS[std]) {
            edits.push({ field: "standard_edition", action: "correct", value: EDITIONS[std], note });
            said.push(`${std}:${EDITIONS[std]}`);
          }
          break;
        }
        case "quantity": {
          const raw = lot.data.fields.total_kg.raw_value;
          const n = raw ? Number(String(raw).replace(/,/g, "").match(/\d+(\.\d+)?/)?.[0]) : NaN;
          if (lot.data.fields.total_kg.issues.includes("ambiguous_ton") && Number.isFinite(n)) {
            edits.push({ field: "total_kg", action: "correct", value: n * 1000, note: `${note}: metric tonnes` });
            said.push(`${fmt(n)} metric tonnes`);
          }
          break;
        }
        case "grade":
          if (!val(lot.data, "grade_raw")) {
            const g = demand.accepted_grades[0];
            edits.push({ field: "grade_raw", action: "correct", value: g.grade, note });
            if (g.standard_id && !val(lot.data, "standard_id")) edits.push({ field: "standard_id", action: "correct", value: g.standard_id, note });
            said.push(`grade ${g.grade}`);
          }
          break;
        case "freshness":
          reconfirm = true;
          said.push("still available");
          break;
      }
    }
    if (!edits.length && !reconfirm) continue;
    answered.add(w.lot_id);
    let version = lot.current_version;
    if (edits.length) version = (await reviewLot(db, actor, w.lot_id, version, edits, now, "simulated seller: answered a buyer's question")).lot.version;
    if (reconfirm) await reconfirmLot(db, actor, w.lot_id, version, now);
    const ref = await lotRef(db, w.lot_id);
    await log(actor, "answer", `${firstName(actor)} answered a buyer about ${ref}: ${said.join("; ")}`, `${await alias(db, actor.network_id)} answered a buyer's question and updated a lot`);
  }
}

async function currentChecks(sql: Sql, lotId: string, demandId: string): Promise<Check[]> {
  const rows = await sql.query<{ checks: Check[] }>(
    `SELECT a.checks FROM match_assessments a
       JOIN lots l ON l.id = a.lot_id AND l.current_version = a.lot_version
       JOIN demands d ON d.id = a.demand_id AND d.current_version = a.demand_version
      WHERE a.lot_id = $1 AND a.demand_id = $2
      ORDER BY a.created_at DESC LIMIT 1`,
    [lotId, demandId],
  );
  return rows[0]?.checks ?? [];
}

async function sellSomething(db: Db, m: Market, rnd: () => number, now: Date, log: Log) {
  const seller = pick(rnd, m.sellers);
  const actor = await actorOf(db, seller.user);
  const live = await db.query<{ id: string; current_version: number }>(
    `SELECT id, current_version FROM lots WHERE owner_network_id = $1 AND status = 'published' AND id LIKE 'lot-sim-%' ORDER BY id`,
    [actor.network_id],
  );
  if (!live.length) return;
  const lot = pick(rnd, live);
  await setLotStatus(db, actor, lot.id, lot.current_version, "sold", now);
  await log(actor, "sold", `${firstName(actor)} sold ${await lotRef(db, lot.id)} to a buyer outside HiddenLot`, `${await alias(db, actor.network_id)} sold a lot`);
}

// --- reading the activity ------------------------------------------------------------

export interface MarketEventView {
  id: string;
  at: Date;
  network_alias: string;
  own: boolean;
  kind: string;
  summary: string;
}

/**
 * What a network may see of the simulated activity: everything its own users
 * did, and a one-line summary from networks that currently share stock with
 * it. Nothing from anyone else; demands are never shared.
 */
export async function listMarketEvents(sql: Sql, networkId: string, now: Date, limit = 60): Promise<MarketEventView[]> {
  return sql.query<MarketEventView>(
    `SELECT e.id::text AS id, e.at, n.alias AS network_alias, e.network_id = $1 AS own, e.kind,
            CASE WHEN e.network_id = $1 THEN e.owner_summary ELSE e.shared_summary END AS summary
       FROM market_events e JOIN networks n ON n.id = e.network_id
      WHERE e.network_id = $1
         OR (e.shared_summary IS NOT NULL AND EXISTS (
               SELECT 1 FROM sharing_grants g
                WHERE g.owner_network_id = e.network_id AND g.recipient_network_id = $1
                  AND g.allow_discovery AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > $2)))
      ORDER BY e.at DESC, e.id DESC
      LIMIT $3`,
    [networkId, now.toISOString(), limit],
  );
}

// --- queries and helpers -------------------------------------------------------------

async function partnerDemands(sql: Sql, sellerNetworkId: string): Promise<Demand[]> {
  const rows = await sql.query<{ data: Demand }>(
    `SELECT v.data FROM demands d JOIN demand_versions v ON v.demand_id = d.id AND v.version = d.current_version
      WHERE d.status = 'active' AND d.buyer_network_id IN
            (SELECT recipient_network_id FROM sharing_grants WHERE owner_network_id = $1 AND revoked_at IS NULL AND allow_discovery)
      ORDER BY d.id`,
    [sellerNetworkId],
  );
  return rows.map((r) => r.data);
}

async function actorOf(sql: Sql, userId: string): Promise<Actor> {
  const u = (await sql.query<Actor>(`SELECT id, network_id, role FROM users WHERE id = $1`, [userId]))[0];
  if (!u) throw new Error(`market: unknown user ${userId}`);
  return u;
}

async function alias(sql: Sql, networkId: string) {
  return (await sql.query<{ alias: string }>(`SELECT alias FROM networks WHERE id = $1`, [networkId]))[0]?.alias ?? networkId;
}

async function lotRef(sql: Sql, lotId: string) {
  const lot = await getLot(sql, lotId);
  return (lot && val<string>(lot.data, "seller_lot_ref")) ?? lotId;
}

const firstName = (a: Actor) => a.id.replace(/^u-/, "").replace(/^./, (c) => c.toUpperCase());

function val<T>(lot: InventoryLot, f: InventoryLotField): T | null {
  return (lot.fields[f]?.normalized_value ?? null) as T | null;
}

/** mulberry32: small, fast, and the same sequence on every platform. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rnd: () => number, xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const between = (rnd: () => number, [lo, hi]: [number, number]) => lo + Math.floor(rnd() * (hi - lo + 1));
const mid = (lo: number | null, hi: number | null, fallback: number) => (lo !== null && hi !== null ? round2((lo + hi) / 2) : (lo ?? hi ?? fallback));
const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => {
  const r = round2(n);
  return Number.isInteger(r) ? r.toFixed(1) : String(r);
};
const day = (now: Date, plus: number) => new Date(now.getTime() + plus * 86_400_000).toISOString().slice(0, 10);
