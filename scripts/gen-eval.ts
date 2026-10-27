/**
 * Generates the held-out synthetic evaluation set (plan §13.2–13.3) from a
 * fixed seed: canonical truth first, then documents rendered from templates
 * in several formats and languages. Sets eval–eval3 share template family A, whose phrasing
 * influenced prompts v4/v5; eval4 uses template family B, which no prompt has seen.
 *
 *   npm run data:eval        # writes data/synthetic/eval/ (deterministic)
 *
 * Every lot's truth lists the raw text the renderer wrote, so gold values are
 * produced by the same post-checks as model output.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";

// eval  (seed 20261027): first held-out set, scored with prompt v3; v4 was then changed in response to its errors.
// eval2 (seed 20261028): fresh locked test, generated after prompt v4 changed in
// response to eval errors, so v4 is never scored on the set that motivated it.
// eval3 (seed 20261029): fresh locked test after prompt v5 (certificate names) changed in response to eval2.
// eval4 (seed 20261030): fresh set from a SECOND template family (layouts and
// phrasing the prompt has never quoted), generated after prompt v6.
const SETS = { eval: 20261027, eval2: 20261028, eval3: 20261029, eval4: 20261030 } as const;
const FAMILY_B = SET_NAME() === "eval4";
function SET_NAME() {
  return process.argv.includes("--set") ? process.argv[process.argv.indexOf("--set") + 1] : "eval";
}
const SET = SET_NAME() as keyof typeof SETS;
const SEED = SETS[SET];
const OUT = path.join(process.cwd(), "data", "synthetic", SET);

// mulberry32
let state: number = SEED;
const rand = () => {
  state |= 0;
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const chance = (p: number) => rand() < p;

type Truth = [unknown, string] | [unknown, string, string | null];
interface Lot {
  lot_id: string;
  anchor: string;
  fields: Record<string, Truth>;
}

const GRADES = [
  { grade: "SS400", std: "JIS G3101" },
  { grade: "Q235B", std: "GB/T 700" },
  { grade: "S235JR", std: "EN 10025-2" },
  { grade: "SS400", std: "KS D3503" },
  { grade: "A36", std: "ASTM A36" },
  { grade: "Q345B", std: "GB/T 1591" },
] as const;
const THICK = [2.0, 2.3, 2.5, 2.75, 3.0, 3.0, 3.0, 3.2, 4.0, 6.0];
const WIDTH = [1219, 1250, 1500, 1500, 1524, 1800];
const PLACES = [
  ["Busan port", "釜山港"],
  ["Tianjin port", "天津港"],
  ["Kaohsiung", "高雄"],
  ["Ho Chi Minh City warehouse", "胡志明市仓库"],
  ["Incheon", "仁川"],
] as const;

interface Spec {
  ref: string;
  form: "hot_rolled_coil" | "hot_rolled_plate";
  grade: string;
  std: string | null;
  edition: string | null;
  t: number;
  w: number;
  tons: number;
  coils: number;
  cond: "prime" | "secondary" | null;
  place: readonly [string, string];
  avail: string | null;
  price: number | null;
  incoterm: "CFR" | "FOB" | null;
  mtc: boolean;
  weightUnit: "MT" | "吨" | "ton" | "kg";
  dimUnits: boolean;
}

function spec(prefix: string, i: number): Spec {
  const g = pick(GRADES);
  const day = 1 + Math.floor(rand() * 27);
  const month = pick([11, 11, 12]);
  return {
    ref: `${prefix}-${String(100 + i)}`,
    form: chance(0.12) ? "hot_rolled_plate" : "hot_rolled_coil",
    grade: g.grade,
    std: chance(0.8) ? g.std : null,
    edition: chance(0.25) ? pick(["2015", "2006", "2019"]) : null,
    t: pick(THICK),
    w: pick(WIDTH),
    tons: Math.round((10 + rand() * 16) * 10) / 10,
    coils: 1 + Math.floor(rand() * 3),
    cond: chance(0.7) ? "prime" : chance(0.5) ? "secondary" : null,
    place: pick(PLACES),
    avail: chance(0.85) ? `2026-${month}-${String(day).padStart(2, "0")}` : null,
    price: chance(0.6) ? 480 + Math.floor(rand() * 90) : null,
    incoterm: chance(0.5) ? "CFR" : "FOB",
    mtc: chance(0.6),
    weightUnit: pick(["MT", "MT", "吨", "ton", "kg"]),
    dimUnits: chance(0.85),
  };
}

const weightText = (s: Spec) => (s.weightUnit === "kg" ? `${Math.round(s.tons * 1000)} kg` : s.weightUnit === "吨" ? `${s.tons}吨` : `${s.tons} ${s.weightUnit}`);
const weightTruth = (s: Spec): Truth =>
  s.weightUnit === "kg" ? [Math.round(s.tons * 1000), weightText(s), "kg"] : [s.tons, weightText(s), s.weightUnit];
const stdText = (s: Spec) => (s.std ? (s.edition ? `${s.std}:${s.edition}` : s.std) : null);

/** Text message, English or Chinese, one block per lot. */
function renderText(specs: Spec[], lang: "en" | "zh", net: string): { text: string; lots: Lot[] } {
  const lines = [`[SYNTHETIC EVAL DATA — fictional ${net} offer, not real / 合成评测数据]`, lang === "en" ? "Surplus stock list" : "库存清单", ""];
  const lots: Lot[] = [];
  for (const s of specs) {
    const f: Record<string, Truth> = {};
    const anchor = lang === "en" ? `Lot ${s.ref}` : `批号 ${s.ref}`;
    lines.push(anchor);
    f.seller_lot_ref = [s.ref, s.ref];
    const formWord = s.form === "hot_rolled_plate" ? (lang === "en" ? "hot rolled plate" : "中厚板") : lang === "en" ? "HRC" : "热轧卷";
    f.product_form = [s.form, formWord];
    const std = stdText(s);
    lines.push(`${formWord} ${s.grade}${std ? ` (${std})` : ""}`);
    f.grade = [s.grade, s.grade];
    if (s.std) f.standard_id = [s.std, s.std];
    if (s.std && s.edition) f.standard_edition = [s.edition, std!];
    const tNum = s.t % 1 ? String(s.t) : s.t.toFixed(1); // 2.75, 2.3, 3.0
    const t = s.dimUnits ? `${tNum}mm` : tNum;
    const w = s.dimUnits ? `${s.w}mm` : String(s.w);
    lines.push(lang === "en" ? `Size: ${t} x ${w}` : `规格：${t}*${w}`);
    f.thickness = [Number(t.replace("mm", "")), t, s.dimUnits ? "mm" : null];
    f.width = [s.w, w, s.dimUnits ? "mm" : null];
    const pcs = lang === "en" ? `${s.coils} coil${s.coils > 1 ? "s" : ""}` : `${s.coils}卷`;
    lines.push(lang === "en" ? `Weight: ${weightText(s)}, ${pcs}` : `重量：${weightText(s)}，${pcs}`);
    f.total_weight = weightTruth(s);
    f.piece_count = [s.coils, pcs];
    if (s.cond) {
      const c = s.cond === "prime" ? (lang === "en" ? "prime" : "正品") : lang === "en" ? "secondary" : "二级品";
      lines.push(lang === "en" ? `Quality: ${c}` : `质量：${c}`);
      f.condition = [s.cond, c];
    }
    const place = lang === "en" ? s.place[0] : s.place[1];
    lines.push(lang === "en" ? `Location: ${place}` : `地点：${place}`);
    f.location_place = [place, place];
    if (s.avail) {
      lines.push(lang === "en" ? `Available from ${s.avail}` : `可提货 ${s.avail}`);
      f.available_from = [s.avail, s.avail];
    }
    if (s.mtc) {
      lines.push(lang === "en" ? "MTC available" : "附MTC");
      f.certificate_claims = [["MTC"], "MTC"];
    }
    if (s.price) {
      const dest = s.incoterm === "CFR" ? "Haiphong" : s.place[0].split(" ")[0];
      lines.push(`${lang === "en" ? "Price" : "价格"}: USD ${s.price} / MT ${s.incoterm} ${dest}`);
      f.price_amount = [String(s.price), `USD ${s.price}`];
      f.price_currency = ["USD", "USD"];
      f.price_basis = ["per_mt", `${s.price} / MT`];
      f.incoterm = [s.incoterm, `${s.incoterm} ${dest}`];
      f.incoterm_place = [dest, `${s.incoterm} ${dest}`];
    }
    lines.push("");
    lots.push({ lot_id: `lot-${s.ref.toLowerCase()}`, anchor, fields: f });
  }
  return { text: lines.join("\n"), lots };
}

/**
 * Free-form trader prose: fields in varying order and phrasing, several lots
 * per message, no labels. This is where a regex baseline is expected to
 * struggle and a reading model to help; truth raws are still exact spans.
 */
function renderProse(specs: Spec[], net: string): { text: string; lots: Lot[] } {
  const lines = [`[SYNTHETIC EVAL DATA — fictional ${net} chat message, not a real offer]`, "hi all, clearing some surplus this week:", ""];
  const lots: Lot[] = [];
  for (const s of specs) {
    const f: Record<string, Truth> = {};
    const anchor = `Lot ${s.ref}`;
    const formWord = s.form === "hot_rolled_plate" ? "HR plates" : pick(["HR coils", "hot rolled coils", "HRC"]);
    const tNum = s.t % 1 ? String(s.t) : s.t.toFixed(1);
    const size = s.dimUnits ? `${tNum} by ${s.w} mm` : `${tNum}/${s.w}`;
    const std = stdText(s);
    const pcs = `${s.coils} ${s.form === "hot_rolled_plate" ? "bundles" : s.coils > 1 ? "coils" : "coil"}`;
    const wt = weightText(s);
    const where = s.place[0];
    const parts = [
      `${anchor}: ${pcs} of ${s.grade}${std ? ` to ${std}` : ""} ${formWord}, ${size}, abt ${wt} in total`,
      s.cond === "prime" ? "all prime" : s.cond === "secondary" ? "secondary quality (edge damage)" : "",
      `lying at ${where}`,
      s.avail ? `can release from ${s.avail}` : "",
      s.mtc ? "mill cert (MTC) on hand" : "",
      s.price ? `idea USD ${s.price} / MT ${s.incoterm} ${s.incoterm === "CFR" ? "Haiphong" : where.split(" ")[0]}` : "pls bid",
    ].filter(Boolean);
    const head = parts.shift()!;
    lines.push(`${head}; ${parts.join(", ")}.`);
    f.seller_lot_ref = [s.ref, s.ref];
    f.product_form = [s.form, formWord];
    f.grade = [s.grade, s.grade];
    if (s.std) f.standard_id = [s.std, s.std];
    if (s.std && s.edition) f.standard_edition = [s.edition, std!];
    if (s.dimUnits) {
      f.thickness = [Number(tNum), `${tNum} by ${s.w} mm`, "mm"];
      f.width = [s.w, `${s.w} mm`, "mm"];
    } else {
      f.thickness = [Number(tNum), tNum, null];
      f.width = [s.w, String(s.w), null];
    }
    f.total_weight = weightTruth(s);
    f.piece_count = [s.coils, pcs];
    if (s.cond === "prime") f.condition = ["prime", "all prime"];
    if (s.cond === "secondary") {
      f.condition = ["secondary", "secondary quality"];
      f.defect_notes = ["edge damage", "edge damage"];
    }
    f.location_place = [where, where];
    if (s.avail) f.available_from = [s.avail, s.avail];
    if (s.mtc) f.certificate_claims = [["MTC"], "MTC"];
    if (s.price) {
      const dest = s.incoterm === "CFR" ? "Haiphong" : where.split(" ")[0];
      f.price_amount = [String(s.price), `USD ${s.price}`];
      f.price_currency = ["USD", "USD"];
      f.price_basis = ["per_mt", `${s.price} / MT`];
      f.incoterm = [s.incoterm, `${s.incoterm} ${dest}`];
      f.incoterm_place = [dest, `${s.incoterm} ${dest}`];
    }
    lots.push({ lot_id: `lot-${s.ref.toLowerCase()}`, anchor, fields: f });
  }
  lines.push("", "pm me, thx");
  return { text: lines.join("\n"), lots };
}

// ---------------------------------------------------------------------------
// Template family B (eval4 only).

const pieceWord = (s: Spec, lang: "en" | "zh") =>
  s.form === "hot_rolled_plate" ? (lang === "en" ? `${s.coils} pcs` : `${s.coils}张`) : lang === "en" ? `${s.coils} coil${s.coils > 1 ? "s" : ""}` : `${s.coils}卷`;
const cnDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}年${m}月${d}日`;
};

/** One line per lot, fields separated by " | " or "，". */
function renderLinesB(specs: Spec[], lang: "en" | "zh", net: string): { text: string; lots: Lot[] } {
  const lines = [lang === "en" ? `SYNTHETIC EVAL DATA (${net}, fictional) - stock offers` : `合成评测数据（${net}，虚构）现货`, ""];
  const lots: Lot[] = [];
  for (const s of specs) {
    const f: Record<string, Truth> = {};
    const tNum = s.t % 1 ? String(s.t) : s.t.toFixed(1);
    const form = s.form === "hot_rolled_plate" ? (lang === "en" ? "HR plate" : "中板") : lang === "en" ? "HRC" : "热卷";
    const std = stdText(s);
    const gradeStd = std ? `${s.grade} / ${std}` : s.grade;
    const size = s.dimUnits ? `${tNum} x ${s.w} mm` : `${tNum}x${s.w}`;
    const pcs = pieceWord(s, lang);
    const wt = weightText(s);
    const parts =
      lang === "en"
        ? [`Ref ${s.ref}`, form, gradeStd, size, `${pcs}, approx ${wt}`, s.place[0], s.cond ?? "", s.mtc ? "MTC copy" : "", s.avail ? `ex ${s.avail}` : "", s.price ? `USD ${s.price}/MT ${s.incoterm} ${s.incoterm === "CFR" ? "Haiphong" : s.place[0].split(" ")[0]}` : ""]
        : [`编号 ${s.ref}`, form, gradeStd, size, `${pcs}共${wt}`, s.place[1], s.cond === "prime" ? "正品" : s.cond === "secondary" ? "次品" : "", s.mtc ? "带MTC" : "", s.avail ? `${cnDate(s.avail)}后可提` : ""];
    lines.push(parts.filter(Boolean).join(lang === "en" ? " | " : "，"));
    f.seller_lot_ref = [s.ref, s.ref];
    f.product_form = [s.form, form];
    f.grade = [s.grade, s.grade];
    if (s.std) f.standard_id = [s.std, s.std];
    if (s.std && s.edition) f.standard_edition = [s.edition, std!];
    f.thickness = [Number(tNum), size, s.dimUnits ? "mm" : null];
    f.width = [s.w, size, s.dimUnits ? "mm" : null];
    f.total_weight = weightTruth(s);
    f.piece_count = [s.coils, pcs];
    if (s.cond) f.condition = [s.cond, lang === "en" ? s.cond : s.cond === "prime" ? "正品" : "次品"];
    f.location_place = [lang === "en" ? s.place[0] : s.place[1], lang === "en" ? s.place[0] : s.place[1]];
    if (s.avail) f.available_from = [s.avail, lang === "en" ? s.avail : cnDate(s.avail)];
    if (s.mtc) f.certificate_claims = [["MTC"], lang === "en" ? "MTC copy" : "带MTC"];
    if (s.price && lang === "en") {
      const dest = s.incoterm === "CFR" ? "Haiphong" : s.place[0].split(" ")[0];
      f.price_amount = [String(s.price), `USD ${s.price}`];
      f.price_currency = ["USD", "USD"];
      f.price_basis = ["per_mt", `${s.price}/MT`];
      f.incoterm = [s.incoterm, `${s.incoterm} ${dest}`];
      f.incoterm_place = [dest, `${s.incoterm} ${dest}`];
    }
    lots.push({ lot_id: `lot-${s.ref.toLowerCase()}`, anchor: s.ref, fields: f });
  }
  return { text: lines.join("\n"), lots };
}

/** Prose in a different register from family A: email-style sentences, bare reference first. */
function renderProseB(specs: Spec[], net: string): { text: string; lots: Lot[] } {
  const lines = [`[SYNTHETIC EVAL DATA - ${net} email, fictional]`, "Dear partners, please find our ex-stock positions below.", ""];
  const lots: Lot[] = [];
  for (const s of specs) {
    const f: Record<string, Truth> = {};
    const tNum = s.t % 1 ? String(s.t) : s.t.toFixed(1);
    const form = s.form === "hot_rolled_plate" ? "hot-rolled plates" : "hot-rolled coil";
    const std = stdText(s);
    const size = s.dimUnits ? `${tNum} x ${s.w}mm` : `${tNum} x ${s.w}`;
    const pcs = pieceWord(s, "en");
    const wt = weightText(s);
    let line = `${s.ref} — ${s.grade}${std ? ` (${std})` : ""} ${form} ${size}, net ${wt} in ${pcs}, currently in ${s.place[0]}`;
    if (s.cond === "prime") line += ", prime material";
    if (s.cond === "secondary") line += ", seconds (surface marks)";
    if (s.mtc) line += ", mill test certificate (MTC) sent on request";
    if (s.avail) line += `, ready for loading from ${s.avail}`;
    line += s.price ? `. Target USD ${s.price}/MT ${s.incoterm} ${s.incoterm === "CFR" ? "Haiphong" : s.place[0].split(" ")[0]}.` : ". Open to offers.";
    lines.push(line);
    f.seller_lot_ref = [s.ref, s.ref];
    f.product_form = [s.form, form];
    f.grade = [s.grade, s.grade];
    if (s.std) f.standard_id = [s.std, s.std];
    if (s.std && s.edition) f.standard_edition = [s.edition, std!];
    f.thickness = [Number(tNum), size, s.dimUnits ? "mm" : null];
    f.width = [s.w, size, s.dimUnits ? "mm" : null];
    f.total_weight = weightTruth(s);
    f.piece_count = [s.coils, pcs];
    if (s.cond === "prime") f.condition = ["prime", "prime material"];
    if (s.cond === "secondary") {
      f.condition = ["secondary", "seconds"];
      f.defect_notes = ["surface marks", "surface marks"];
    }
    f.location_place = [s.place[0], s.place[0]];
    if (s.avail) f.available_from = [s.avail, s.avail];
    if (s.mtc) f.certificate_claims = [["MTC"], "mill test certificate (MTC) sent on request"];
    if (s.price) {
      const dest = s.incoterm === "CFR" ? "Haiphong" : s.place[0].split(" ")[0];
      f.price_amount = [String(s.price), `USD ${s.price}`];
      f.price_currency = ["USD", "USD"];
      f.price_basis = ["per_mt", `${s.price}/MT`];
      f.incoterm = [s.incoterm, `${s.incoterm} ${dest}`];
      f.incoterm_place = [dest, `${s.incoterm} ${dest}`];
    }
    lots.push({ lot_id: `lot-${s.ref.toLowerCase()}`, anchor: s.ref, fields: f });
  }
  lines.push("", "Best regards");
  return { text: lines.join("\n"), lots };
}

/** Table family B: combined "Grade / Std" and "Size" columns, different headers. */
function renderTableB(specs: Spec[]) {
  const H = ["Ref", "Item", "Grade / Std", "Size", "Pcs", "Net wt", "Status", "Store", "ETD", "Docs"];
  const rows: string[][] = [];
  const lots: Lot[] = [];
  for (const s of specs) {
    const tNum = s.t % 1 ? String(s.t) : s.t.toFixed(1);
    const std = stdText(s);
    const size = s.dimUnits ? `${tNum} x ${s.w} mm` : `${tNum} x ${s.w}`;
    const row = [s.ref, s.form === "hot_rolled_plate" ? "HR plate" : "HR coil", std ? `${s.grade} / ${std}` : s.grade, size, String(s.coils), weightText(s), s.cond ?? "", s.place[0], s.avail ?? "", s.mtc ? "MTC" : ""];
    rows.push(row);
    const seg = (i: number) => `${H[i]}: ${row[i]}`;
    const f: Record<string, Truth> = {
      seller_lot_ref: [s.ref, seg(0)],
      product_form: [s.form, seg(1)],
      grade: [s.grade, seg(2)],
      thickness: [Number(tNum), seg(3), s.dimUnits ? "mm" : null],
      width: [s.w, seg(3), s.dimUnits ? "mm" : null],
      piece_count: [s.coils, seg(4)],
      total_weight: [weightTruth(s)[0], seg(5), weightTruth(s)[2] ?? null],
      location_place: [s.place[0], seg(7)],
    };
    if (s.std) f.standard_id = [s.std, seg(2)];
    if (s.std && s.edition) f.standard_edition = [s.edition, seg(2)];
    if (s.cond) f.condition = [s.cond, seg(6)];
    if (s.avail) f.available_from = [s.avail, seg(8)];
    if (s.mtc) f.certificate_claims = [["MTC"], seg(9)];
    lots.push({ lot_id: `lot-${s.ref.toLowerCase()}`, anchor: seg(0), fields: f });
  }
  return { header: H, rows, lots };
}

/** Table with English or Chinese headers; each field's raw is its "Header: value" segment. */
function renderTable(specs: Spec[], lang: "en" | "zh") {
  const H =
    lang === "en"
      ? ["Lot", "Product", "Grade", "Standard", "Thickness", "Width", "Weight", "Coils", "Condition", "Location", "Ready", "MTC"]
      : ["批号", "品名", "牌号", "标准", "厚度", "宽度", "重量", "卷数", "质量", "地点", "可提货", "质保书"];
  const rows: string[][] = [];
  const lots: Lot[] = [];
  for (const s of specs) {
    const t = s.dimUnits ? `${s.t} mm` : String(s.t);
    const w = s.dimUnits ? `${s.w} mm` : String(s.w);
    const form = s.form === "hot_rolled_plate" ? (lang === "en" ? "Plate" : "中厚板") : lang === "en" ? "HRC" : "热轧卷";
    const cond = s.cond ? (lang === "en" ? s.cond : s.cond === "prime" ? "正品" : "二级品") : "";
    const place = lang === "en" ? s.place[0] : s.place[1];
    const row = [s.ref, form, s.grade, stdText(s) ?? "", t, w, weightText(s), String(s.coils), cond, place, s.avail ?? "", s.mtc ? "MTC" : ""];
    rows.push(row);
    const seg = (i: number) => `${H[i]}: ${row[i]}`;
    const f: Record<string, Truth> = {
      seller_lot_ref: [s.ref, seg(0)],
      product_form: [s.form, seg(1)],
      grade: [s.grade, seg(2)],
      thickness: [s.t, seg(4), s.dimUnits ? "mm" : null],
      width: [s.w, seg(5), s.dimUnits ? "mm" : null],
      total_weight: [weightTruth(s)[0], seg(6), weightTruth(s)[2] ?? null],
      piece_count: [s.coils, seg(7)],
      location_place: [place, seg(9)],
    };
    if (s.std) f.standard_id = [s.std, seg(3)];
    if (s.std && s.edition) f.standard_edition = [s.edition, seg(3)];
    if (s.cond) f.condition = [s.cond, seg(8)];
    if (s.avail) f.available_from = [s.avail, seg(10)];
    if (s.mtc) f.certificate_claims = [["MTC"], seg(11)];
    lots.push({ lot_id: `lot-${s.ref.toLowerCase()}`, anchor: seg(0), fields: f });
  }
  return { header: H, rows, lots };
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

async function main() {
  mkdirSync(OUT, { recursive: true });
  const documents: Record<string, unknown>[] = [];
  const nets = ["net-d", "net-e", "net-f"];
  let n = 0;
  const plan: { kind: "text" | "csv" | "xlsx" | "pdf" | "prose"; lang: "en" | "zh"; lots: number }[] = [
    { kind: "text", lang: "en", lots: 4 },
    { kind: "text", lang: "zh", lots: 4 },
    { kind: "csv", lang: "en", lots: 4 },
    { kind: "csv", lang: "zh", lots: 3 },
    { kind: "xlsx", lang: "en", lots: 4 },
    { kind: "pdf", lang: "en", lots: 2 },
    { kind: "pdf", lang: "en", lots: 1 },
    { kind: "text", lang: "en", lots: 2 },
    { kind: "prose", lang: "en", lots: 4 },
    { kind: "prose", lang: "en", lots: 4 },
    { kind: "prose", lang: "en", lots: 4 },
  ];
  const planB: { kind: "text" | "csv" | "xlsx" | "pdf" | "prose"; lang: "en" | "zh"; lots: number }[] = [
    { kind: "text", lang: "en", lots: 4 },
    { kind: "text", lang: "zh", lots: 4 },
    { kind: "csv", lang: "en", lots: 4 },
    { kind: "xlsx", lang: "en", lots: 4 },
    { kind: "pdf", lang: "en", lots: 3 },
    { kind: "prose", lang: "en", lots: 4 },
    { kind: "prose", lang: "en", lots: 4 },
    { kind: "prose", lang: "en", lots: 4 },
    { kind: "text", lang: "en", lots: 3 },
    { kind: "text", lang: "zh", lots: 2 },
  ];
  for (const [d, p] of (FAMILY_B ? planB : plan).entries()) {
    const net = nets[d % nets.length];
    const prefix = ["D", "E", "F"][d % 3];
    const specs = Array.from({ length: p.lots }, () => spec(prefix, n++));
    const id = `eval-doc-${String(d + 1).padStart(2, "0")}`;
    let file: string;
    let lots: Lot[];
    if (FAMILY_B && p.kind !== "csv" && p.kind !== "xlsx") {
      if (p.kind === "pdf") for (const sp of specs) if (sp.weightUnit === "吨") sp.weightUnit = "MT";
      const r = p.kind === "prose" ? renderProseB(specs, net) : renderLinesB(specs, p.kind === "pdf" ? "en" : p.lang, net);
      file = `${id}.${p.kind === "pdf" ? "pdf" : "txt"}`;
      if (p.kind === "pdf") {
        const pdf = await PDFDocument.create({ updateMetadata: false });
        pdf.setTitle("SYNTHETIC EVAL DATA");
        pdf.setCreationDate(new Date("2026-10-27T00:00:00Z"));
        pdf.setModificationDate(new Date("2026-10-27T00:00:00Z"));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const page = pdf.addPage([842, 595]);
        r.text.split("\n").forEach((line, i) => line && page.drawText(line.replace(/[^\x20-\x7e]/g, ""), { x: 30, y: 560 - i * 18, size: 9, font }));
        writeFileSync(path.join(OUT, file), await pdf.save());
      } else writeFileSync(path.join(OUT, file), r.text);
      lots = r.lots;
    } else if (FAMILY_B) {
      const r = renderTableB(specs);
      const title = `SYNTHETIC EVAL DATA - fictional ${net} positions`;
      if (p.kind === "csv") {
        file = `${id}.csv`;
        writeFileSync(path.join(OUT, file), [title, r.header.map(csvCell).join(","), ...r.rows.map((row) => row.map(csvCell).join(","))].join("\n") + "\n");
      } else {
        file = `${id}.xlsx`;
        const wb = new ExcelJS.Workbook();
        wb.creator = "HiddenLot synthetic eval";
        wb.created = new Date("2026-10-27T00:00:00Z");
        wb.modified = wb.created;
        const ws = wb.addWorksheet("Positions");
        ws.addRow([title]);
        ws.addRow(r.header);
        for (const row of r.rows) ws.addRow(row);
        writeFileSync(path.join(OUT, file), new Uint8Array(await wb.xlsx.writeBuffer()));
      }
      lots = r.lots;
    } else if (p.kind === "prose") {
      const r = renderProse(specs, net);
      file = `${id}.txt`;
      writeFileSync(path.join(OUT, file), r.text);
      lots = r.lots;
    } else if (p.kind === "text") {
      const r = renderText(specs, p.lang, net);
      file = `${id}.txt`;
      writeFileSync(path.join(OUT, file), r.text);
      lots = r.lots;
    } else if (p.kind === "pdf") {
      // Standard PDF fonts cannot draw CJK; use the Latin unit so the truth matches the page.
      for (const sp of specs) if (sp.weightUnit === "吨") sp.weightUnit = "MT";
      const r = renderText(specs, "en", net);
      file = `${id}.pdf`;
      const pdf = await PDFDocument.create({ updateMetadata: false });
      pdf.setTitle("SYNTHETIC EVAL DATA");
      pdf.setCreationDate(new Date("2026-10-27T00:00:00Z"));
      pdf.setModificationDate(new Date("2026-10-27T00:00:00Z"));
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const page = pdf.addPage([595, 842]);
      r.text.split("\n").forEach((line, i) => line && page.drawText(line.replace(/[^\x20-\x7e]/g, ""), { x: 56, y: 790 - i * 18, size: 10, font }));
      writeFileSync(path.join(OUT, file), await pdf.save());
      lots = r.lots;
    } else {
      const r = renderTable(specs, p.lang);
      const title = `SYNTHETIC EVAL DATA — fictional ${net} stock list`;
      if (p.kind === "csv") {
        file = `${id}.csv`;
        writeFileSync(path.join(OUT, file), [title, r.header.map(csvCell).join(","), ...r.rows.map((row) => row.map(csvCell).join(","))].join("\n") + "\n");
      } else {
        file = `${id}.xlsx`;
        const wb = new ExcelJS.Workbook();
        wb.creator = "HiddenLot synthetic eval";
        wb.created = new Date("2026-10-27T00:00:00Z");
        wb.modified = wb.created;
        const ws = wb.addWorksheet("Stock");
        ws.addRow([title]);
        ws.addRow(r.header);
        for (const row of r.rows) ws.addRow(row);
        writeFileSync(path.join(OUT, file), new Uint8Array(await wb.xlsx.writeBuffer()));
      }
      lots = r.lots;
    }
    documents.push({ id, network_id: net, uploaded_by: `u-${net}`, kind: p.kind === "prose" ? "text" : p.kind, style: `${FAMILY_B ? "B" : "A"}-${p.kind === "prose" ? "prose" : "templated"}`, file, lots });
  }

  // Demands: each is built around one real lot from another network (so true
  // candidates exist) and then perturbed, so near-misses exist too.
  const allSpecs = documents.flatMap((d) => (d.lots as Lot[]).map((l) => ({ net: d.network_id as string, lot: l })));
  const demands = [];
  for (let k = 0; k < 12; k++) {
    const base = allSpecs[Math.floor(rand() * allSpecs.length)];
    const f = base.lot.fields;
    const net = nets[(nets.indexOf(base.net) + 1 + (k % 2)) % nets.length];
    const t = Number(f.thickness[0]);
    const w = Number(f.width[0]);
    const kg = f.total_weight[2] === "kg" ? Number(f.total_weight[0]) : Number(f.total_weight[0]) * 1000;
    const std = (f.standard_id?.[0] as string | undefined) ?? null;
    const cond = (f.condition?.[0] as string | undefined) ?? "prime";
    // Requirements are drawn so the base lot itself satisfies them; other lots
    // (and base lots with unstated units or ambiguous "ton") supply the negatives.
    const policy = chance(0.5) ? "forbidden" : "review_required";
    const needCert = f.certificate_claims !== undefined && chance(0.6);
    demands.push({
      demand_id: `eval-dem-${k + 1}`,
      buyer_network_id: net,
      created_by: `u-${net}`,
      title: `Eval demand ${k + 1}: HRC ${f.grade[0]} ${t} × ${w}`,
      product_form: "hot_rolled_coil",
      quantity_kg: { min: Math.round(kg * 0.8), target: Math.round(kg), max: Math.round(kg * 1.2) },
      thickness_mm: { min: Math.round((t - 0.05) * 100) / 100, max: Math.round((t + 0.05) * 100) / 100, source: "buyer_explicit" },
      width_mm: { min: w - 5, max: w + 5, source: "buyer_explicit" },
      accepted_grades: [{ grade: f.grade[0] as string, standard_id: std && chance(0.7) ? std : null, edition: null }],
      substitution_policy: policy,
      acceptable_conditions: cond === "secondary" ? ["prime", "secondary"] : ["prime"],
      must_have_certificates: needCert ? ["MTC"] : [],
      allow_partial_delivery: chance(0.3),
      allow_multi_lot: false,
      destination: "Haiphong",
      need_by: chance(0.8) ? "2026-12-31" : null,
      budget: chance(0.5) ? { amount: "560", currency: "USD", basis: "per_mt", incoterm: "CFR", place: "Haiphong" } : null,
      expires_at: null,
    });
  }

  const truth = {
    dataset: "hiddenlot-eval",
    version: `${SET}-v1`,
    split: "locked_test",
    seed: SEED,
    synthetic: true,
    notice: FAMILY_B
      ? "Generated synthetic truth for evaluation only. Fictional networks and lots. Template family B: no prompt or regex was written with these layouts or phrases in view."
      : "Generated synthetic truth for evaluation only. Fictional networks and lots. Template family A: later prompt versions were adjusted after errors seen on earlier family-A sets.",
    networks: nets.map((id) => ({ id, name: `${id} (fictional eval network)`, alias: id, region: "-" })),
    demands,
    documents,
  };
  const json = JSON.stringify(truth, null, 2) + "\n";
  writeFileSync(path.join(OUT, "canonical.json"), json);
  console.log(`wrote ${documents.length} documents, ${n} lots to ${path.relative(process.cwd(), OUT)} (sha256 ${createHash("sha256").update(json).digest("hex").slice(0, 12)})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
