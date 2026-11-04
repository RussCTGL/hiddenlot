import type { InventoryLot, InventoryLotField } from "@/domain/hrc";
import type { TextFragment } from "@/ingestion/text-fragments";
import type { Quote } from "./deals";

// One template per order document: the fields it must show, which of them are
// required, and what each must agree with on the order (the accepted offer,
// the lot as it was sold, the two networks, and documents already on the
// order). A file attached to a step is read line by line: a value is taken
// only from a labelled line ("Unit price: USD 498/MT") and keeps that line as
// its quote. Nothing is guessed: a field with no labelled line is "not found".

export type DocTemplateId = "proforma" | "payment" | "mtc" | "bill_of_lading";

/** What the order says, for comparing documents against. Unknown stays null. */
export interface OrderFacts {
  buyer: string;
  seller: string;
  lotRef: string;
  grade: string | null;
  standard: string | null;
  thickness_mm: number | null;
  width_mm: number | null;
  lot_t: number | null;
  heats: string[] | null;
  quote: Quote | null;
  /** Read from the proforma already on the order, for checks across documents. */
  proforma: { file: string; amount: string | null; quantity: string | null } | null;
  /** ISO day the check runs, for expiry dates. */
  today: string;
}

interface Expectation {
  /** The expected value as a trader would write it. */
  text: string;
  /** Where it comes from: "the offer", "the lot", "the proforma". */
  source: string;
  test: (found: string) => boolean;
}

interface FieldSpec {
  key: string;
  label: string;
  required: boolean;
  /** Line labels the value is read from; the first one is used when generating. */
  labels: string[];
  /** In words, for the template list. */
  rule: string;
  expect?: (f: OrderFacts) => Expectation | null;
  /** When there is no labelled line, read the value from another field's line (e.g. currency from the amount). */
  fallback?: { field: string; pick: (line: string) => string | null };
}

export interface DocTemplate {
  id: DocTemplateId;
  title: string;
  step: "contract" | "payment" | "mtc" | "shipped";
  by: "buyer" | "seller";
  fields: FieldSpec[];
}

/** B/L gross weight and MTC weight may differ this much from the contract quantity (packing, scale). */
export const WEIGHT_TOLERANCE = 0.05;

// --- reading values ---------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tight = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "");
const contains = (found: string, want: string) => ` ${norm(found)} `.includes(` ${norm(want)} `);
const NUM = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/;
export const parseNumber = (s: string) => {
  const m = s.match(NUM);
  return m ? Number(m[0].replace(/,/g, "")) : null;
};
const CURRENCIES = ["USD", "EUR", "CNY", "RMB", "JPY", "GBP", "KRW", "INR", "VND", "THB", "TRY", "AED"];
export function parseCurrency(s: string): string | null {
  const m = s.toUpperCase().match(new RegExp(`\\b(${CURRENCIES.join("|")})\\b`));
  if (m) return m[1] === "RMB" ? "CNY" : m[1];
  if (s.includes("US$") || s.includes("$")) return "USD";
  if (s.includes("€")) return "EUR";
  return null;
}
/** A weight in tonnes, only when the unit is written. */
export function parseTonnes(s: string): number | null {
  const m = s.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(mt|t|tons?|tonnes?|kgs?|lbs?)\b/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  const unit = m[2].toLowerCase();
  return unit.startsWith("kg") ? n / 1000 : unit.startsWith("lb") ? (n * 0.45359237) / 1000 : n;
}
export function parseSize(s: string): { t: number; w: number } | null {
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:mm)?\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
  return m ? { t: Number(m[1]), w: Number(m[2]) } : null;
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** ISO day from "2026-11-10" or "10 Nov 2026"; anything else is not read. */
export function parseDay(s: string): string | null {
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})\b/);
  const mon = dmy ? MONTHS.indexOf(dmy[2].toLowerCase()) : -1;
  return dmy && mon >= 0 ? `${dmy[3]}-${String(mon + 1).padStart(2, "0")}-${dmy[1].padStart(2, "0")}` : null;
}
const money = (cur: string, n: number) => `${cur} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tonnes = (n: number) => `${Math.round(n * 1000) / 1000} t`;
const sizeText = (t: number, w: number) => `${t} x ${w} mm`;

/** Price × quantity from the offer, when both are known. */
export function offerAmount(q: Quote | null): { currency: string; value: number } | null {
  const price = q ? Number(q.price) : NaN;
  return q && q.quantity_t && Number.isFinite(price) ? { currency: q.currency, value: Math.round(price * q.quantity_t * 100) / 100 } : null;
}

/** The contract quantity: the proforma's if it was read, else the offer's, else the lot's. */
function contractTonnes(f: OrderFacts): { value: number; source: string } | null {
  const pf = f.proforma?.quantity ? parseTonnes(f.proforma.quantity) : null;
  if (pf !== null) return { value: pf, source: "the proforma" };
  if (f.quote?.quantity_t) return { value: f.quote.quantity_t, source: "the offer" };
  return f.lot_t !== null ? { value: f.lot_t, source: "the lot" } : null;
}

const party = (who: "buyer" | "seller") => (f: OrderFacts): Expectation => {
  const name = f[who];
  return { text: name, source: "the order", test: (x) => contains(x, name) };
};
const lotRefIs = (f: OrderFacts): Expectation => ({ text: f.lotRef, source: "the lot", test: (x) => tight(x).includes(tight(f.lotRef)) });
const gradeIs = (f: OrderFacts): Expectation | null =>
  f.grade
    ? {
        text: [f.grade, f.standard].filter(Boolean).join(" "),
        source: "the lot",
        test: (x) => tight(x).includes(tight(f.grade!)) && (!f.standard || tight(x).includes(tight(f.standard))),
      }
    : null;
const sizeIs = (f: OrderFacts): Expectation | null =>
  f.thickness_mm !== null && f.width_mm !== null
    ? {
        text: sizeText(f.thickness_mm, f.width_mm),
        source: "the lot",
        test: (x) => {
          const s = parseSize(x);
          return !!s && Math.abs(s.t - f.thickness_mm!) < 0.005 && Math.abs(s.w - f.width_mm!) < 0.5;
        },
      }
    : null;
const weightNear = (f: OrderFacts): Expectation | null => {
  const c = contractTonnes(f);
  return c
    ? {
        text: `${tonnes(c.value)} ± ${WEIGHT_TOLERANCE * 100}%`,
        source: c.source,
        test: (x) => {
          const t = parseTonnes(x);
          return t !== null && Math.abs(t - c.value) <= c.value * WEIGHT_TOLERANCE + 1e-9;
        },
      }
    : null;
};
const currencyIs = (f: OrderFacts): Expectation | null => (f.quote ? { text: f.quote.currency, source: "the offer", test: (x) => parseCurrency(x) === f.quote!.currency.toUpperCase() } : null);
const amountMatches = (want: { currency: string; value: number }, source: string): Expectation => ({
  text: money(want.currency, want.value),
  source,
  test: (x) => {
    const n = parseNumber(x);
    const cur = parseCurrency(x);
    return n !== null && Math.abs(n - want.value) < 0.005 && (cur === null || cur === want.currency.toUpperCase());
  },
});
const isDay = (x: string) => parseDay(x) !== null;
const currencyFrom = (field: string) => ({ field, pick: (line: string) => parseCurrency(line) });

// --- the templates -----------------------------------------------------------------

export const DOC_TEMPLATES: Record<DocTemplateId, DocTemplate> = {
  proforma: {
    id: "proforma",
    title: "Proforma / contract",
    step: "contract",
    by: "seller",
    fields: [
      { key: "number", label: "Proforma no.", required: false, labels: ["Proforma no.", "Proforma number", "PI no.", "Contract no."], rule: "Any reference" },
      { key: "seller", label: "Seller", required: true, labels: ["Seller", "Beneficiary"], rule: "The seller's network", expect: party("seller") },
      { key: "buyer", label: "Buyer", required: true, labels: ["Buyer"], rule: "The buyer's network", expect: party("buyer") },
      { key: "lot", label: "Lot ref", required: true, labels: ["Lot ref", "Lot", "Seller lot ref"], rule: "The lot sold", expect: lotRefIs },
      { key: "grade", label: "Grade / spec", required: true, labels: ["Grade / spec", "Grade", "Spec", "Specification"], rule: "Grade and standard of the lot", expect: gradeIs },
      { key: "size", label: "Size", required: true, labels: ["Size", "Dimensions"], rule: "Thickness x width of the lot", expect: sizeIs },
      {
        key: "quantity",
        label: "Quantity",
        required: true,
        labels: ["Quantity", "Qty"],
        rule: "Quantity in the accepted offer",
        expect: (f) => (f.quote?.quantity_t ? { text: tonnes(f.quote.quantity_t), source: "the offer", test: (x) => parseTonnes(x) === f.quote!.quantity_t } : null),
      },
      {
        key: "price",
        label: "Unit price",
        required: true,
        labels: ["Unit price", "Price"],
        rule: "Price per MT in the accepted offer",
        expect: (f) =>
          f.quote
            ? {
                text: `${f.quote.currency} ${f.quote.price}/MT`,
                source: "the offer",
                test: (x) => parseNumber(x) === Number(f.quote!.price) && [null, f.quote!.currency.toUpperCase()].includes(parseCurrency(x)),
              }
            : null,
      },
      { key: "currency", label: "Currency", required: true, labels: ["Currency"], rule: "Currency of the offer", expect: currencyIs, fallback: currencyFrom("price") },
      {
        key: "incoterm",
        label: "Incoterm and place",
        required: true,
        labels: ["Incoterm", "Terms of delivery", "Delivery terms", "Delivery"],
        rule: "Incoterm and place in the accepted offer",
        expect: (f) => (f.quote ? { text: f.quote.incoterm, source: "the offer", test: (x) => contains(x, f.quote!.incoterm) } : null),
      },
      {
        key: "amount",
        label: "Amount",
        required: true,
        labels: ["Total amount", "Amount", "Total"],
        rule: "Unit price x quantity",
        expect: (f) => {
          const a = offerAmount(f.quote);
          return a ? amountMatches(a, "the offer (price x quantity)") : null;
        },
      },
      { key: "payment_terms", label: "Payment terms", required: true, labels: ["Payment terms", "Payment"], rule: "Stated" },
      {
        key: "validity",
        label: "Validity",
        required: false,
        labels: ["Valid until", "Validity", "Offer valid until"],
        rule: "Offer validity date",
        expect: (f) => (f.quote?.valid_until ? { text: f.quote.valid_until, source: "the offer", test: (x) => parseDay(x) === f.quote!.valid_until } : { text: "a date", source: "the template", test: isDay }),
      },
    ],
  },
  payment: {
    id: "payment",
    title: "L/C or payment proof",
    step: "payment",
    by: "buyer",
    fields: [
      { key: "number", label: "L/C or payment no.", required: true, labels: ["L/C no.", "L/C number", "LC no.", "Credit number", "Payment reference", "Reference", "Transfer reference"], rule: "Stated" },
      { key: "applicant", label: "Applicant", required: true, labels: ["Applicant", "Payer", "Ordering customer"], rule: "The buyer's network", expect: party("buyer") },
      { key: "beneficiary", label: "Beneficiary", required: true, labels: ["Beneficiary", "Payee"], rule: "The seller's network", expect: party("seller") },
      {
        key: "amount",
        label: "Amount",
        required: true,
        labels: ["Amount", "Credit amount", "Total"],
        rule: "Same as the proforma amount",
        expect: (f) => {
          const pf = f.proforma?.amount;
          const n = pf ? parseNumber(pf) : null;
          const cur = pf ? parseCurrency(pf) : null;
          if (n !== null && cur) return amountMatches({ currency: cur, value: n }, `the proforma (${f.proforma!.file})`);
          const a = offerAmount(f.quote);
          return a ? amountMatches(a, "the offer (price x quantity)") : null;
        },
      },
      { key: "currency", label: "Currency", required: true, labels: ["Currency"], rule: "Currency of the offer", expect: currencyIs, fallback: currencyFrom("amount") },
      { key: "goods", label: "Goods / lot", required: true, labels: ["Goods", "Description of goods", "Goods description"], rule: "Names the lot", expect: lotRefIs },
      {
        key: "documents",
        label: "Documents required",
        required: false,
        labels: ["Documents required", "Documents", "Required documents"],
        rule: "Includes the bill of lading and the mill test certificate",
        expect: () => ({
          text: "bill of lading, mill test certificate",
          source: "the order steps",
          test: (x) => /bill of lading|\bb\/l\b/i.test(x) && /mill test|\bmtc\b/i.test(x),
        }),
      },
      {
        key: "expiry",
        label: "Expiry",
        required: true,
        labels: ["Expiry", "Expiry date", "Expires", "Date of expiry", "Valid until"],
        rule: "A date after today",
        expect: (f) => ({ text: `after ${f.today}`, source: "today's date", test: (x) => (parseDay(x) ?? "") > f.today }),
      },
    ],
  },
  mtc: {
    id: "mtc",
    title: "Mill test certificate",
    step: "mtc",
    by: "seller",
    fields: [
      { key: "number", label: "Certificate no.", required: true, labels: ["Certificate no.", "Certificate number", "Cert no.", "MTC no."], rule: "Stated" },
      { key: "grade", label: "Grade / standard", required: true, labels: ["Grade / standard", "Grade", "Steel grade", "Standard"], rule: "Grade and standard of the lot", expect: gradeIs },
      {
        key: "heats",
        label: "Heat numbers",
        required: true,
        labels: ["Heat numbers", "Heat no.", "Heat No", "Heats", "Heat"],
        rule: "Stated; heats on the lot, when the lot lists them",
        expect: (f) =>
          f.heats?.length
            ? {
                text: f.heats.join(", "),
                source: "the lot",
                test: (x) => {
                  const got = x.split(/[,;/\s]+/).map(tight).filter((h) => /\d/.test(h));
                  return got.length > 0 && got.every((h) => f.heats!.some((k) => tight(k) === h));
                },
              }
            : null,
      },
      { key: "size", label: "Dimensions", required: true, labels: ["Dimensions", "Size"], rule: "Thickness x width of the lot", expect: sizeIs },
      { key: "weight", label: "Weight", required: true, labels: ["Weight", "Net weight", "Total weight"], rule: `Contract quantity ± ${WEIGHT_TOLERANCE * 100}%`, expect: weightNear },
      { key: "chemistry", label: "Chemical composition", required: true, labels: ["Chemical composition", "Chemistry", "Chemical"], rule: "Results present" },
      { key: "mechanical", label: "Mechanical results", required: true, labels: ["Mechanical results", "Mechanical properties", "Mechanical", "Tensile"], rule: "Results present" },
    ],
  },
  bill_of_lading: {
    id: "bill_of_lading",
    title: "Bill of lading",
    step: "shipped",
    by: "seller",
    fields: [
      { key: "number", label: "B/L no.", required: true, labels: ["B/L no.", "B/L number", "Bill of lading no.", "BL no."], rule: "Stated" },
      { key: "shipper", label: "Shipper", required: true, labels: ["Shipper"], rule: "The seller's network", expect: party("seller") },
      { key: "consignee", label: "Consignee / notify", required: true, labels: ["Consignee", "Notify party", "Notify"], rule: "The buyer's network", expect: party("buyer") },
      { key: "vessel", label: "Vessel", required: true, labels: ["Vessel", "Vessel / voyage", "Ocean vessel"], rule: "Stated" },
      {
        key: "pol",
        label: "Port of loading",
        required: true,
        labels: ["Port of loading", "POL"],
        rule: "Stated; the Incoterm place for F terms (FOB, FCA, FAS)",
        expect: (f) => incotermPort(f, "F"),
      },
      {
        key: "pod",
        label: "Port of discharge",
        required: true,
        labels: ["Port of discharge", "POD"],
        rule: "Stated; the Incoterm place for C terms (CFR, CIF, CPT, CIP)",
        expect: (f) => incotermPort(f, "C"),
      },
      { key: "goods", label: "Goods description", required: true, labels: ["Goods description", "Description of goods", "Goods"], rule: "Names the grade", expect: gradeIs },
      { key: "weight", label: "Gross weight", required: true, labels: ["Gross weight", "Weight"], rule: `Contract quantity ± ${WEIGHT_TOLERANCE * 100}%`, expect: weightNear },
      { key: "date", label: "Shipped on board date", required: true, labels: ["Shipped on board", "On board date", "Date of shipment", "B/L date", "Date"], rule: "A date", expect: () => ({ text: "a date", source: "the template", test: isDay }) },
    ],
  },
};

function incotermPort(f: OrderFacts, group: "F" | "C"): Expectation | null {
  const m = f.quote?.incoterm.trim().match(/^([A-Z]{3})\s+(.+)$/i);
  if (!m || m[1].toUpperCase()[0] !== group) return null;
  const place = m[2];
  return { text: place, source: `the offer (${f.quote!.incoterm})`, test: (x) => contains(x, place) };
}

export const STEP_TEMPLATE: Partial<Record<string, DocTemplateId>> = { contract: "proforma", payment: "payment", mtc: "mtc", shipped: "bill_of_lading" };
export const templateForStep = (step: string | null) => (step && STEP_TEMPLATE[step] ? DOC_TEMPLATES[STEP_TEMPLATE[step]!] : null);

// --- checking a document -----------------------------------------------------------

export interface FieldCheck {
  key: string;
  label: string;
  required: boolean;
  /** ok: found and agrees (or nothing to compare); differs: found but disagrees; missing: no labelled line. */
  status: "ok" | "differs" | "missing";
  expected: string | null;
  source: string | null;
  found: string | null;
  /** The line the value was read from, with its locator (P1L4, L3, Sheet1!R2). */
  quote: { at: string; text: string } | null;
}

export interface DocCheck {
  template: DocTemplateId;
  title: string;
  /** False when no text could be read (scan, image, Word file); every field is then "missing". */
  readable: boolean;
  note: string | null;
  fields: FieldCheck[];
  checked_at: string;
  generated: boolean;
}

/** Required fields that differ or were not found. */
export const docIssues = (c: DocCheck | null) => (c ? c.fields.filter((f) => f.required && f.status !== "ok") : []);
export const docDiffers = (c: DocCheck | null) => (c ? c.fields.filter((f) => f.status === "differs") : []);

/** "Size: expected 2.75 x 1250 mm, found 2.70 x 1250 mm; Heat numbers not found". */
export function issuesText(c: DocCheck, max = 3) {
  const list = docIssues(c);
  const parts = list.slice(0, max).map((f) => (f.status === "differs" ? `${f.label}: expected ${f.expected}, found ${f.found}` : `${f.label} not found`));
  return parts.join("; ") + (list.length > max ? `; and ${list.length - max} more` : "");
}

const PLACEHOLDER = /^(unknown|not stated|n\/?a|-+|tbd|tba|to be agreed|\?+)$/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The value after "Label:" on a line, up to the next "  Other label:" or table cell. */
function readLabelled(fragments: TextFragment[], labels: string[]): { value: string; at: string; text: string } | null {
  const re = new RegExp(`(?:^|[\\s|;(])(?:${labels.map(esc).join("|")})\\s*[:：]\\s*(.*)$`, "i");
  for (const fr of fragments) {
    const m = fr.text.match(re);
    if (!m) continue;
    const value = m[1].split(/\s+\|\s+|\s{3,}(?=[A-Z][\w /.&-]{0,30}[:：])/)[0].trim();
    if (value) return { value, at: fr.id, text: fr.text.trim() };
  }
  return null;
}

/** Checks a document's lines against its template and the order. Deterministic: no model call. */
export function checkDocument(id: DocTemplateId, fragments: TextFragment[] | null, facts: OrderFacts, now: Date, opts: { note?: string | null; generated?: boolean } = {}): DocCheck {
  const t = DOC_TEMPLATES[id];
  const read = new Map<string, { value: string; at: string; text: string } | null>();
  for (const spec of t.fields) read.set(spec.key, fragments ? readLabelled(fragments, spec.labels) : null);
  const fields = t.fields.map((spec): FieldCheck => {
    let hit = read.get(spec.key) ?? null;
    if (!hit && spec.fallback) {
      const from = read.get(spec.fallback.field);
      const v = from ? spec.fallback.pick(from.value) : null;
      if (from && v) hit = { ...from, value: v };
    }
    if (hit && PLACEHOLDER.test(hit.value)) hit = null;
    const exp = spec.expect?.(facts) ?? null;
    const base = { key: spec.key, label: spec.label, required: spec.required, expected: exp?.text ?? null, source: exp?.source ?? null };
    if (!hit) return { ...base, status: "missing", found: null, quote: null };
    return { ...base, status: !exp || exp.test(hit.value) ? "ok" : "differs", found: hit.value, quote: { at: hit.at, text: hit.text } };
  });
  return { template: id, title: t.title, readable: fragments !== null, note: opts.note ?? null, fields, checked_at: now.toISOString(), generated: opts.generated ?? false };
}

/** The template's rules with this order's values, for showing before anything is attached. */
export function templateRules(id: DocTemplateId, facts: OrderFacts) {
  return DOC_TEMPLATES[id].fields.map((f) => {
    const e = f.expect?.(facts) ?? null;
    return { label: f.label, required: f.required, rule: e ? `${e.text} (from ${e.source})` : f.rule };
  });
}

// --- the order's facts and the generated proforma -----------------------------------------

function lotVal<T>(lot: InventoryLot | null, f: InventoryLotField): T | null {
  const o = lot?.fields[f];
  return !o || o.status === "not_stated" || o.status === "unresolved" ? null : (o.normalized_value as T | null);
}

export function orderFacts(lot: InventoryLot | null, lotRef: string, quote: Quote | null, buyer: string, seller: string, proforma: DocCheck | null, proformaFile: string | null, now: Date): OrderFacts {
  const kg = lotVal<number>(lot, "total_kg");
  const found = (k: string) => proforma?.fields.find((f) => f.key === k && f.status !== "missing")?.found ?? null;
  return {
    buyer,
    seller,
    lotRef,
    grade: lotVal<string>(lot, "grade_raw"),
    standard: lotVal<string>(lot, "standard_id"),
    thickness_mm: lotVal<number>(lot, "thickness_mm"),
    width_mm: lotVal<number>(lot, "width_mm"),
    lot_t: kg === null ? null : kg / 1000,
    heats: lotVal<string[]>(lot, "heat_numbers"),
    quote,
    proforma: proforma && proformaFile ? { file: proformaFile, amount: found("amount"), quantity: found("quantity") } : null,
    today: now.toISOString().slice(0, 10),
  };
}

const unknown = (x: string | null | undefined) => x ?? "Unknown";

/** The proforma's lines, one labelled field per line, from the order alone. Unknown values say so. */
export function proformaLines(f: OrderFacts, number: string, paymentTerms: string): string[] {
  const q = f.quote;
  const a = offerAmount(q);
  const label = (key: string) => DOC_TEMPLATES.proforma.fields.find((x) => x.key === key)!.labels[0];
  const rows: [string, string | null][] = [
    ["number", number],
    ["seller", `${f.seller} (fictional)`],
    ["buyer", `${f.buyer} (fictional)`],
    ["lot", f.lotRef],
    ["grade", f.grade ? ["HRC", f.grade, f.standard].filter(Boolean).join(" ") : null],
    ["size", f.thickness_mm !== null && f.width_mm !== null ? sizeText(f.thickness_mm, f.width_mm) : null],
    ["quantity", q?.quantity_t ? tonnes(q.quantity_t) : null],
    ["price", q ? `${q.currency} ${q.price}/MT` : null],
    ["currency", q?.currency ?? null],
    ["incoterm", q?.incoterm ?? null],
    ["amount", a ? money(a.currency, a.value) : null],
    ["payment_terms", paymentTerms.trim() || null],
    ["validity", q?.valid_until ?? null],
  ];
  return rows.map(([k, v]) => `${label(k)}: ${unknown(v)}`);
}
