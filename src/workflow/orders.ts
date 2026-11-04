import { ForbiddenError, NotFoundError, type Actor } from "@/auth/access";
import type { Db, Sql } from "@/db/client";
import { audit, getLot, newId } from "@/db/repo";
import { detectKind, parseDocument } from "@/ingestion/intake";
import { tinyPdf } from "@/lib/tiny-pdf";
import { setLotStatus } from "./actions";
import { event, fmtDay, lotRef, update, type DealRow, type DealStage, type Quote } from "./deals";
import { checkDocument, docIssues, issuesText, orderFacts, proformaLines, templateForStep, templateRules, type DocCheck, type OrderFacts } from "./doc-templates";

// After the buyer accepts an offer, buyer and seller share one deal: the steps
// to delivery, whose turn it is, and the files each side shares. Either side
// sees the other's progress as soon as it is saved. The buyer's demand stays
// private; the seller sees the order, the lot and the steps.

export type Side = "buyer" | "seller";

export const ORDER_STEPS = [
  { id: "confirmed", label: "Order confirmed", by: "seller", hint: "Confirm you will sell this lot on these terms. The lot is marked sold and leaves other buyers' view." },
  { id: "contract", label: "Contract or proforma sent", by: "seller", hint: "Attach the sales contract or proforma invoice." },
  { id: "payment", label: "Payment or L/C arranged", by: "buyer", hint: "Attach the payment slip or the L/C copy." },
  { id: "mtc", label: "Mill test certificate shared", by: "seller", hint: "Attach the MTC and any inspection report." },
  { id: "shipped", label: "Loaded and shipped", by: "seller", hint: "Give the B/L number and attach the bill of lading." },
  { id: "received", label: "Goods received", by: "buyer", hint: "Confirm the coils arrived as ordered. This completes the order." },
] as const;
export type OrderStep = (typeof ORDER_STEPS)[number]["id"];

/** Kinds of file a deal accepts: documents and scans, nothing executable. */
const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
  txt: "text/plain",
};
export const FILE_ACCEPT = Object.keys(FILE_TYPES).map((x) => `.${x}`).join(",");
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface OrderParty {
  deal: DealRow;
  side: Side;
  buyer: string;
  seller: string;
  sellerNetwork: string;
}

/** The deal, if the actor's network is its buyer or owns its lot; anyone else gets not found. */
export async function getDealForParty(sql: Sql, actor: Actor, id: string): Promise<OrderParty> {
  const d = (
    await sql.query<DealRow & { owner: string; buyer_alias: string; seller_alias: string }>(
      `SELECT d.id, d.buyer_network_id, d.demand_id, d.lot_id, d.stage, d.ask, d.follow_up_on::text AS follow_up_on, d.snoozed_until::text AS snoozed_until,
              d.quote, d.closed_reason, d.order_lot, d.lot_version_at_start, d.created_by, d.created_at, d.updated_at,
              l.owner_network_id AS owner, b.alias AS buyer_alias, s.alias AS seller_alias
         FROM deals d JOIN lots l ON l.id = d.lot_id JOIN networks b ON b.id = d.buyer_network_id JOIN networks s ON s.id = l.owner_network_id
        WHERE d.id = $1`,
      [id],
    )
  )[0];
  if (!d) throw new NotFoundError("Deal not found");
  const side: Side | null = d.buyer_network_id === actor.network_id ? "buyer" : d.owner === actor.network_id ? "seller" : null;
  if (!side) throw new NotFoundError("Deal not found");
  const { owner, buyer_alias, seller_alias, ...deal } = d;
  return { deal, side, buyer: buyer_alias, seller: seller_alias, sellerNetwork: owner };
}

export interface StepView {
  id: OrderStep;
  label: string;
  by: Side;
  hint: string;
  done: { at: Date; note: string | null; who: string } | null;
  /** The first step not done yet. */
  next: boolean;
  /** The document this step's template asks for, and what it must show for this order. */
  template: { title: string; rules: { label: string; required: boolean; rule: string }[] } | null;
  /** The latest file attached to this step, with its check against the template. */
  doc: DealFile | null;
  /** Why the step was completed although its document had open points. */
  override: string | null;
}

export interface DealFile {
  id: string;
  filename: string;
  size_bytes: number;
  step: string | null;
  side: Side;
  who: string;
  created_at: Date;
  check: DocCheck | null;
}

export interface OrderView {
  side: Side;
  stage: DealStage;
  quote: Quote | null;
  buyer: string;
  seller: string;
  steps: StepView[];
  files: DealFile[];
  /** Whose turn it is, from the actor's point of view. */
  waitingOn: "you" | "them" | null;
}

export async function getOrderView(db: Db, actor: Actor, id: string): Promise<OrderView> {
  const p = await getDealForParty(db, actor, id);
  const done = new Map(
    (
      await db.query<{ step: string; done_at: Date; note: string | null; name: string; override_reason: string | null }>(
        `SELECT m.step, m.done_at, m.note, m.override_reason, u.name FROM deal_milestones m JOIN users u ON u.id = m.done_by WHERE m.deal_id = $1`,
        [id],
      )
    ).map((m) => [m.step, m]),
  );
  const files = await listFiles(db, p);
  const facts = factsFor(p, files, new Date());
  const nextId = p.deal.stage === "ordered" ? ORDER_STEPS.find((s) => !done.has(s.id))?.id : undefined;
  const steps: StepView[] = ORDER_STEPS.map((s) => {
    const m = done.get(s.id);
    const t = templateForStep(s.id);
    return {
      id: s.id,
      label: s.label,
      by: s.by,
      hint: s.hint,
      done: m ? { at: m.done_at, note: m.note, who: firstName(m.name) } : null,
      next: s.id === nextId,
      template: t ? { title: t.title, rules: templateRules(t.id, facts) } : null,
      doc: stepDoc(files, s.id),
      override: m?.override_reason ?? null,
    };
  });
  const next = steps.find((s) => s.next);
  return {
    side: p.side,
    stage: p.deal.stage,
    quote: p.deal.quote,
    buyer: p.buyer,
    seller: p.seller,
    steps,
    files,
    waitingOn: next ? (next.by === p.side ? "you" : "them") : null,
  };
}

/** The latest file attached to a step (files are listed newest first). */
const stepDoc = (files: DealFile[], step: string) => files.find((f) => f.step === step) ?? null;

/** What documents on this order are checked against: the offer, the lot as sold, the networks, the proforma. */
function factsFor(p: OrderParty, files: DealFile[], now: Date): OrderFacts {
  const pf = stepDoc(files, "contract");
  return orderFacts(p.deal.order_lot, lotRef(p.deal.order_lot, p.deal.lot_id), p.deal.quote, p.buyer, p.seller, pf?.check ?? null, pf?.filename ?? null, now);
}

const firstName = (name: string) => name.replace(/\s*\(.*?\)/, "").split(" · ")[0];

async function listFiles(db: Db, p: OrderParty): Promise<DealFile[]> {
  const rows = await db.query<{ id: string; filename: string; size_bytes: number; step: string | null; network_id: string; name: string; created_at: Date; doc_check: DocCheck | null }>(
    `SELECT f.id, f.filename, f.size_bytes, f.step, f.network_id, u.name, f.created_at, f.doc_check FROM deal_files f JOIN users u ON u.id = f.uploaded_by WHERE f.deal_id = $1 ORDER BY f.created_at DESC, f.id DESC`,
    [p.deal.id],
  );
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    size_bytes: r.size_bytes,
    step: r.step,
    side: r.network_id === p.deal.buyer_network_id ? "buyer" : "seller",
    who: firstName(r.name),
    created_at: r.created_at,
    check: r.doc_check,
  }));
}

export interface Upload {
  filename: string;
  bytes: Uint8Array;
}

function checkUpload(f: Upload) {
  const ext = f.filename.split(".").pop()?.toLowerCase() ?? "";
  const mime = FILE_TYPES[ext];
  if (!mime) throw new Error(`Only ${Object.keys(FILE_TYPES).join(", ")} files`);
  if (f.bytes.length === 0) throw new Error("The file is empty");
  if (f.bytes.length > MAX_FILE_BYTES) throw new Error(`Files up to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  return { mime, filename: f.filename.replace(/[^\w.\- ()]+/g, "_").slice(-120) };
}

async function storeFile(sql: Sql, actor: Actor, p: OrderParty, step: string | null, f: Upload, now: Date, check: DocCheck | null = null) {
  const { mime, filename } = checkUpload(f);
  await sql.query(
    `INSERT INTO deal_files (id, deal_id, network_id, uploaded_by, step, filename, mime, size_bytes, content, created_at, doc_check) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [newId("dfile"), p.deal.id, actor.network_id, actor.id, step, filename, mime, f.bytes.length, f.bytes, now, check === null ? null : JSON.stringify(check)],
  );
  return filename;
}

const alias = (p: OrderParty) => (p.side === "buyer" ? p.buyer : p.seller);

/**
 * Reads a file attached to a step and checks it against the step's template.
 * Text PDFs, CSV, XLSX and text are read the same way as intake; images and
 * Word files are kept but not read, so every field is "not found".
 */
async function checkStepFile(db: Db, p: OrderParty, step: string, f: Upload, now: Date, generated = false): Promise<DocCheck | null> {
  const t = templateForStep(step);
  if (!t) return null;
  const facts = factsFor(p, await listFiles(db, p), now);
  const ext = f.filename.split(".").pop()?.toLowerCase() ?? "";
  if (!["pdf", "csv", "txt", "xlsx"].includes(ext)) return checkDocument(t.id, null, facts, now, { note: "Images and Word files are kept but not read. Check this document by eye." });
  try {
    const { fragments } = await parseDocument(detectKind(f.filename, null, f.bytes), f.bytes);
    return checkDocument(t.id, fragments, facts, now, { generated });
  } catch (err) {
    return checkDocument(t.id, null, facts, now, { note: `Could not read the text: ${(err as Error).message}` });
  }
}

/** The event for a file attached to a step: says plainly when it differs from the order. */
function stepFileEvent(p: OrderParty, label: string, name: string, check: DocCheck | null) {
  const what = check ? `as the ${check.title.toLowerCase()}` : `for "${label}"`;
  if (check && docIssues(check).length) return { kind: `${p.side}_doc_mismatch`, note: `${alias(p)} attached ${name} ${what}. It does not match the order: ${issuesText(check)}` };
  return { kind: `${p.side}_file`, note: `${alias(p)} attached ${name} ${what}${check ? `; every required field matches the order` : ""}` };
}

/**
 * Shares a file on the deal with the other side, at any stage but a lost deal.
 * With a step (the next one, the actor's own), the file is that step's
 * document and is checked against the step's template.
 */
export async function addDealFile(db: Db, actor: Actor, id: string, f: Upload, now: Date, step: OrderStep | null = null, generated = false) {
  const p = await getDealForParty(db, actor, id);
  if (p.deal.stage === "lost") throw new ForbiddenError("This deal is closed");
  const own = step ? await ownNextStep(db, actor, p, step) : null;
  checkUpload(f);
  const check = step ? await checkStepFile(db, p, step, f, now, generated) : null;
  await db.transaction(async (tx) => {
    const name = await storeFile(tx, actor, p, step, f, now, check);
    const e = own ? stepFileEvent(p, own.def.label, name, check) : { kind: `${p.side}_file`, note: `${alias(p)} shared ${name}` };
    await event(tx, p.deal.id, actor.id, e.kind, e.note, now);
  });
  return check;
}

/** The step's definition, if it is the next step on an order in progress and the actor's side owns it. */
async function ownNextStep(db: Db, actor: Actor, p: OrderParty, step: OrderStep) {
  if (p.deal.stage !== "ordered") throw new ForbiddenError("This deal is not an order in progress");
  const view = await getOrderView(db, actor, p.deal.id);
  const next = view.steps.find((s) => s.next);
  const def = ORDER_STEPS.find((s) => s.id === step);
  if (!def || !next || next.id !== step) throw new ForbiddenError("That step is not next");
  if (def.by !== p.side) throw new ForbiddenError(`The ${def.by} does this step`);
  return { def, view };
}

/** The seller builds the proforma from the order and the template, and attaches it to the contract step. */
export async function createProforma(db: Db, actor: Actor, id: string, paymentTerms: string, now: Date) {
  const p = await getDealForParty(db, actor, id);
  await ownNextStep(db, actor, p, "contract");
  if (!paymentTerms.trim()) throw new Error("Give the payment terms (for example: irrevocable L/C at sight)");
  const facts = factsFor(p, await listFiles(db, p), now);
  const number = `PI-${facts.lotRef.replace(/[^A-Za-z0-9]/g, "")}-${String(now.getUTCFullYear()).slice(2)}`;
  const bytes = tinyPdf(`PROFORMA INVOICE ${number}`, proformaLines(facts, number, paymentTerms.slice(0, 120)));
  return addDealFile(db, actor, id, { filename: `Proforma ${number}.pdf`, bytes }, now, "contract", true);
}

/** Thrown when a step's document has open points and no reason was given to complete anyway. */
export class DocumentMismatchError extends ForbiddenError {}

/**
 * Marks the next step done. Only the side that owns it can, and only in order.
 * Confirming marks the lot sold (other buyers' deals on it close); receipt
 * completes the order as won.
 */
export async function completeStep(db: Db, actor: Actor, id: string, step: OrderStep, note: string, file: Upload | null, now: Date, override = "") {
  const p = await getDealForParty(db, actor, id);
  const { def, view } = await ownNextStep(db, actor, p, step);
  if (file) checkUpload(file);
  const text = note.trim().slice(0, 500) || null;
  // The step's document: the file sent with it, else the latest one attached to the step.
  const check = file ? await checkStepFile(db, p, step, file, now) : (view.steps.find((s) => s.id === step)?.doc?.check ?? null);
  const issues = docIssues(check);
  const why = override.trim().slice(0, 500) || null;
  if (check && issues.length && !why) {
    throw new DocumentMismatchError(`The ${check.title.toLowerCase()} does not match the order: ${issuesText(check)}. Attach a corrected document, or complete anyway and give a reason.`);
  }

  if (step === "confirmed") {
    const lot = await getLot(db, p.deal.lot_id);
    if (!lot) throw new NotFoundError("Lot not found");
    if (lot.status !== "published") throw new ForbiddenError("This lot is no longer published");
    await setLotStatus(db, actor, lot.id, lot.current_version, "sold", now);
  }
  await db.transaction(async (tx) => {
    const forced = check && issues.length ? why : null;
    await tx.query(`INSERT INTO deal_milestones (deal_id, step, done_by, done_at, note, override_reason) VALUES ($1,$2,$3,$4,$5,$6)`, [p.deal.id, step, actor.id, now, text, forced]);
    const name = file ? await storeFile(tx, actor, p, step, file, now, check) : null;
    const done = `${alias(p)}: ${def.label}${text ? ` (${text})` : ""}${name ? `, with ${name}` : ""}`;
    if (forced && check) await event(tx, p.deal.id, actor.id, `${p.side}_doc_mismatch`, `${done}. Completed although the ${check.title.toLowerCase()} does not match the order (${issuesText(check)}). Reason: ${forced}`, now);
    else await event(tx, p.deal.id, actor.id, `${p.side}_step`, done, now);
    if (step === "received") {
      await update(tx, p.deal, { stage: "won", closed_reason: "Order complete: goods received" }, now);
      await audit(tx, actor.id, "deal.order_complete", "deal", p.deal.id, {});
    }
  });
}

/** The seller turns the order down before confirming it; the deal closes as lost. */
export async function declineOrder(db: Db, actor: Actor, id: string, reason: string, now: Date) {
  const why = reason.trim();
  if (!why) throw new Error("Give a reason");
  const p = await getDealForParty(db, actor, id);
  if (p.side !== "seller") throw new ForbiddenError("Only the seller can decline");
  const view = await getOrderView(db, actor, id);
  if (p.deal.stage !== "ordered" || view.steps[0].done) throw new ForbiddenError("Only an unconfirmed order can be declined");
  await db.transaction(async (tx) => {
    await update(tx, p.deal, { stage: "lost", closed_reason: `${p.seller} declined the order: ${why}` }, now);
    await event(tx, p.deal.id, actor.id, "seller_step", `${p.seller} declined the order: ${why}`, now);
  });
}

/** A shared file's bytes, for either side of its deal. */
export async function getDealFile(db: Db, actor: Actor, dealId: string, fileId: string) {
  await getDealForParty(db, actor, dealId);
  const f = (
    await db.query<{ filename: string; mime: string; b64: string }>(`SELECT filename, mime, encode(content, 'base64') AS b64 FROM deal_files WHERE id = $1 AND deal_id = $2`, [fileId, dealId])
  )[0];
  if (!f) throw new NotFoundError("File not found");
  return { filename: f.filename, mime: f.mime, bytes: Buffer.from(f.b64.replace(/\s+/g, ""), "base64") };
}

export interface SellerOrder {
  dealId: string;
  buyer: string;
  lotRef: string;
  title: string;
  stage: DealStage;
  terms: string;
  next: string | null;
  yourTurn: boolean;
  updated: Date;
}

/** Orders on the actor's lots, newest first, with whose step is next. */
export async function listOrdersForSeller(db: Db, actor: Actor): Promise<SellerOrder[]> {
  const rows = await db.query<{ id: string; stage: DealStage; quote: Quote | null; buyer: string; ref: string | null; updated_at: Date; steps: string[] | null }>(
    `SELECT d.id, d.stage, d.quote, d.updated_at, n.alias AS buyer, v.data->'fields'->'seller_lot_ref'->>'normalized_value' AS ref,
            (SELECT array_agg(step) FROM deal_milestones m WHERE m.deal_id = d.id) AS steps
       FROM deals d JOIN lots l ON l.id = d.lot_id JOIN lot_versions v ON v.lot_id = l.id AND v.version = l.current_version JOIN networks n ON n.id = d.buyer_network_id
      WHERE l.owner_network_id = $1 AND d.buyer_network_id <> $1 AND (d.stage = 'ordered' OR (d.stage = 'won' AND d.order_lot IS NOT NULL))
      ORDER BY d.updated_at DESC`,
    [actor.network_id],
  );
  return rows.map((r) => {
    const next = r.stage === "ordered" ? ORDER_STEPS.find((s) => !(r.steps ?? []).includes(s.id)) : undefined;
    const q = r.quote;
    return {
      dealId: r.id,
      buyer: r.buyer,
      lotRef: r.ref ?? r.id,
      title: q ? `${q.quantity_t ? `${q.quantity_t} t · ` : ""}${q.currency} ${q.price}/MT ${q.incoterm}` : "",
      stage: r.stage,
      terms: q?.valid_until ? `valid until ${fmtDay(q.valid_until)}` : "",
      next: next ? next.label : null,
      yourTurn: next?.by === "seller",
      updated: r.updated_at,
    };
  });
}
