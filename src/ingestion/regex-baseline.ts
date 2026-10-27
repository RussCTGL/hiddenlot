import type { ExtractedLot, SupplyExtraction } from "@/ai/tasks/extract-supply";
import { LOT_REF_LINE } from "@/domain/hrc";
import type { TextFragment } from "./text-fragments";

// Baseline B1 (plan §14.2): keywords + regular expressions, no model.
// It emits the same claim shape as the Meta extractor and goes through the
// same deterministic post-checks, so the two can be compared on identical
// inputs. It is deliberately honest rather than tuned to the test fixtures:
// a unit is only attached when it is written next to the number.

export const REGEX_BASELINE_VERSION = "regex-baseline.v1";

type Claim = { value: unknown; raw: string | null; evidence: string[] };
const none = (): Claim => ({ value: null, raw: null, evidence: [] });

const LOT_REF = LOT_REF_LINE;
const GRADE = /\b(SS\s?\d{3}|Q\d{3}[A-E]?|S\d{3}J[R0-2](?:\+[A-Z]+)?|SPHC|SPHT\d?|SM\d{3}[A-C]?|A36|SAE\s?10\d{2})\b/i;
const STANDARD = /\b(JIS\s?G\s?\d{4}|GB\/T\s?\d{3,5}|EN\s?10025(?:-\d)?|ASTM\s?A\s?\d{2,4}|KS\s?D\s?\d{4})(?:\s*[:：]\s*(\d{4}))?/i;
const DIMS = /(\d+(?:\.\d+)?)\s*(mm)?\s*[x×*]\s*(\d{3,4}(?:\.\d+)?)\s*(mm)?/i;
const WEIGHT = /(\d+(?:\.\d+)?)\s*(MT|mt|tonnes?|tons?|吨|kg|KG|t)(?![A-Za-z])/;
const PIECES = /(\d+)\s*(coils?|卷|pcs)/i;
const PLACE = /(?:location|库存地点|地点|warehouse|stored at)\s*[:：]\s*([^,，;|\n]+)/i;
const DATE = /(\d{4}-\d{2}-\d{2})/;
const PRICE = /(USD|US\$|EUR|CNY|RMB)\s*([\d,]+(?:\.\d+)?)\s*(?:\/\s*(MT|t|吨|lot))?/i;
const INCOTERM = /\b(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\s+([A-Z][A-Za-z]+(?:\s[A-Z][a-z]+)?)/;
const CERT = /\b(MTC|EN\s?10204\s?3\.1)\b/;
const HEAT = /heat(?:\s*no\.?)?\s*[:：]?\s*([A-Z0-9][A-Z0-9-]{4,})/i;

const FORMS: [RegExp, string][] = [
  [/\bHRC\b|hot[\s-]rolled\s+coil|热轧卷|热卷/i, "hot_rolled_coil"],
  [/\bCRC\b|cold[\s-]rolled|冷轧/i, "cold_rolled_coil"],
  [/\bplates?\b|中厚板/i, "hot_rolled_plate"],
  [/cut[\s-]to[\s-]length|\bsheets?\b|开平板/i, "hot_rolled_sheet"],
];
const CONDITIONS: [RegExp, string][] = [
  [/rejected on arrival|拒收/i, "rejected_on_arrival"],
  [/secondary|二级品|次品/i, "secondary"],
  [/\bprime\b|正品/i, "prime"],
];
// Each pattern ends on a whole word so the quoted span passes token-boundary checks.
const REASONS: [RegExp, string][] = [
  [/L\/C\s*cancel\w*|LC cancel\w*|信用证.{0,4}取消/i, "cancelled_lc"],
  [/slitting\w*|分条/i, "slitting_remainder"],
  [/partial shipment\w*|余货/i, "partial_shipment_remainder"],
  [/rejected on arrival|拒收/i, "rejected_on_arrival"],
];
const CURRENCY: Record<string, string> = { USD: "USD", US$: "USD", EUR: "EUR", CNY: "CNY", RMB: "CNY" };

/** For table rows: the "Header: value" segment whose header matches. */
function cellSegment(f: TextFragment, header: RegExp): string | null {
  if (!f.cells) return null;
  for (const seg of f.text.split(" | ")) {
    const i = seg.indexOf(": ");
    if (i > 0 && header.test(seg.slice(0, i))) return seg;
  }
  return null;
}

function first(frags: TextFragment[], re: RegExp, group = 0): { m: RegExpExecArray; f: TextFragment; g: string } | null {
  for (const f of frags) {
    const m = re.exec(f.text);
    if (m && m[group] !== undefined) return { m, f, g: m[group] };
  }
  return null;
}

function segment(fragments: TextFragment[]): { preamble: TextFragment[]; lots: TextFragment[][] } {
  // Tables: every row with a grade or a lot reference is one lot.
  if (fragments.some((f) => f.cells)) {
    const rows = fragments.filter((f) => f.cells && (GRADE.test(f.text) || cellSegment(f, /lot|批号/i)));
    return { preamble: fragments.filter((f) => !rows.includes(f)), lots: rows.map((r) => [r]) };
  }
  // Text: a line with a lot reference starts a new lot.
  const preamble: TextFragment[] = [];
  const lots: TextFragment[][] = [];
  for (const f of fragments) {
    if (LOT_REF.test(f.text)) lots.push([f]);
    else if (lots.length) lots[lots.length - 1].push(f);
    else preamble.push(f);
  }
  if (lots.length === 0) return { preamble: [], lots: [fragments] };
  return { preamble, lots };
}

function claim(hit: { f: TextFragment; g: string } | null, value: unknown, raw?: string): Claim {
  return hit ? { value, raw: raw ?? hit.g, evidence: [hit.f.id] } : none();
}

function numberClaim(f: TextFragment, raw: string, value: number, unit: string | null) {
  return { value, unit, raw, evidence: [f.id] };
}

function extractLot(frags: TextFragment[], preamble: TextFragment[]): ExtractedLot {
  const lot = Object.fromEntries(
    ["seller_lot_ref", "product_form", "grade", "standard_id", "standard_edition", "piece_count", "splittable", "location_country", "location_place", "available_from", "price_amount", "price_currency", "price_basis", "incoterm", "incoterm_place", "condition", "defect_notes", "surplus_reason"].map((k) => [k, none()]),
  ) as unknown as ExtractedLot;
  lot.certificate_claims = { value: [], raw: null, evidence: [] };
  lot.heat_numbers = { value: [], raw: null, evidence: [] };
  lot.thickness = { value: null, unit: null, raw: null, evidence: [] };
  lot.width = { value: null, unit: null, raw: null, evidence: [] };
  lot.total_weight = { value: null, unit: null, raw: null, evidence: [] };

  const row = frags.length === 1 && frags[0].cells ? frags[0] : null;

  const ref = row ? null : first(frags, LOT_REF, 1);
  if (ref) lot.seller_lot_ref = claim(ref, ref.g) as ExtractedLot["seller_lot_ref"];
  else if (row) {
    const seg = cellSegment(row, /lot|批号/i);
    if (seg) lot.seller_lot_ref = { value: seg.slice(seg.indexOf(": ") + 2), raw: seg.slice(seg.indexOf(": ") + 2), evidence: [row.id] };
  }

  for (const [re, form] of FORMS) {
    const hit = first(frags, re) ?? first(preamble, re);
    if (hit) {
      lot.product_form = claim(hit, form, hit.m[0]) as ExtractedLot["product_form"];
      break;
    }
  }

  const grade = first(frags, GRADE, 1);
  if (grade) lot.grade = claim(grade, grade.g) as ExtractedLot["grade"];
  const std = first(frags, STANDARD);
  if (std) {
    lot.standard_id = claim(std, std.m[1], std.m[1]) as ExtractedLot["standard_id"];
    if (std.m[2]) lot.standard_edition = claim(std, std.m[2], std.m[0]) as ExtractedLot["standard_edition"];
  }

  if (row) {
    for (const [key, header] of [["thickness", /thick|厚/i], ["width", /width|宽/i], ["total_weight", /weight|qty|quantity|重量|数量/i]] as const) {
      const seg = cellSegment(row, header);
      if (!seg) continue;
      const num = /(\d+(?:\.\d+)?)/.exec(seg.slice(seg.indexOf(": ") + 2));
      if (!num) continue;
      const unit = /\b(mm|MT|kg|t|tons?|inch)\b|吨/i.exec(seg);
      lot[key] = numberClaim(row, seg, Number(num[1]), unit ? unit[0] : null);
    }
  } else {
    const dims = first(frags, DIMS);
    if (dims) {
      const [, t, tu, w, wu] = dims.m;
      lot.thickness = numberClaim(dims.f, tu ? `${t}${dims.m[0].slice(t.length).match(/^\s*mm/)![0]}` : t, Number(t), tu ?? null);
      lot.width = numberClaim(dims.f, wu ? dims.m[0].slice(dims.m[0].indexOf(w)) : w, Number(w), wu ?? null);
    }
    const wt = first(frags, WEIGHT);
    if (wt) lot.total_weight = numberClaim(wt.f, wt.m[0], Number(wt.m[1]), wt.m[2]);
  }

  const pcs = first(frags, PIECES);
  if (pcs) lot.piece_count = claim(pcs, Number(pcs.m[1]), pcs.m[0]) as ExtractedLot["piece_count"];
  const place = first(frags, PLACE, 1);
  if (place) lot.location_place = claim(place, place.g.trim(), place.g.trim()) as ExtractedLot["location_place"];
  const date = first(frags, DATE, 1);
  if (date) lot.available_from = claim(date, date.g) as ExtractedLot["available_from"];

  const price = first(frags, PRICE);
  if (price) {
    lot.price_amount = claim(price, price.m[2].replace(/,/g, ""), price.m[0]) as ExtractedLot["price_amount"];
    lot.price_currency = claim(price, CURRENCY[price.m[1].toUpperCase()] ?? null, price.m[1]) as ExtractedLot["price_currency"];
    const basis = price.m[3] ? (price.m[3].toLowerCase() === "lot" ? "per_lot" : "per_mt") : null;
    if (basis) lot.price_basis = claim(price, basis, price.m[0]) as ExtractedLot["price_basis"];
  }
  const inc = first(frags, INCOTERM);
  if (inc) {
    lot.incoterm = claim(inc, inc.m[1], inc.m[1]) as ExtractedLot["incoterm"];
    lot.incoterm_place = claim(inc, inc.m[2], inc.m[2]) as ExtractedLot["incoterm_place"];
  }

  const cert = first(frags, CERT, 1);
  if (cert) lot.certificate_claims = { value: [cert.g], raw: cert.g, evidence: [cert.f.id] };
  const heat = first(frags, HEAT, 1);
  if (heat) lot.heat_numbers = { value: [heat.g], raw: heat.g, evidence: [heat.f.id] };

  for (const [re, v] of CONDITIONS) {
    const hit = first(frags, re);
    if (hit) {
      lot.condition = claim(hit, v, hit.m[0]) as ExtractedLot["condition"];
      break;
    }
  }
  for (const [re, v] of REASONS) {
    const hit = first(frags, re);
    if (hit) {
      lot.surplus_reason = claim(hit, v, hit.m[0]) as ExtractedLot["surplus_reason"];
      break;
    }
  }
  return lot;
}

export function regexExtract(fragments: TextFragment[]): SupplyExtraction {
  const { preamble, lots } = segment(fragments);
  return { lots: lots.map((frags) => extractLot(frags, preamble)), ambiguities: [], ignored_instructions: [] };
}
