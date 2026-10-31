import { z } from "zod";
import type { ChatMessage } from "@/ai/meta/client";
import type { Check } from "@/discovery/constraints";
import { budgetText, type Demand, type InventoryLot, type InventoryLotField } from "@/domain/hrc";
import { numbersIn } from "./extract-supply";

// Task B (plan §10.2-B): ExplainCandidate. The model only rephrases facts that
// deterministic code already established. Every sentence must cite fact IDs
// from the given list; sentences without valid citations, with numbers that
// are not in their cited facts, or with certification / equivalence language
// are dropped before anyone sees them. The rule result is never changed here.

export const EXPLAIN_PROMPT_VERSION = "explain-candidate.v1";
export const EXPLAIN_SCHEMA_NAME = "hrc_candidate_explanation_v1";

const Sentence = z.object({ text: z.string(), fact_ids: z.array(z.string()) });
const Question = z.object({ to: z.enum(["seller", "buyer", "engineering"]), question: z.string(), fact_ids: z.array(z.string()) });

export const Explanation = z.object({
  summary: Sentence,
  supported_facts: z.array(Sentence),
  differences_and_unknowns: z.array(Sentence),
  next_questions: z.array(Question),
});
export type Explanation = z.infer<typeof Explanation>;

export interface Fact {
  id: string;
  text: string;
}

const DEMAND_FACTS = (d: Demand): Fact[] => [
  { id: "D1", text: `Buyer accepts grades: ${d.accepted_grades.map((g) => [g.grade, g.standard_id, g.edition].filter(Boolean).join(" ")).join(" / ")}; other grades ${d.substitution_policy === "forbidden" ? "not allowed" : "only after engineering review and buyer approval"}` },
  { id: "D2", text: `Buyer needs thickness ${d.thickness_mm.min ?? "?"}–${d.thickness_mm.max ?? "?"} mm and width ${d.width_mm.min ?? "?"}–${d.width_mm.max ?? "?"} mm` },
  { id: "D3", text: `Buyer needs ${d.quantity_kg.min / 1000}–${d.quantity_kg.max / 1000} t${d.allow_partial_delivery ? ", partial delivery acceptable" : ", no partial delivery"}` },
  { id: "D4", text: `Buyer requires certificates: ${d.must_have_certificates.join(", ") || "none"}; condition: ${d.acceptable_conditions.join(", ")}` },
  { id: "D5", text: `Need-by date: ${d.need_by ?? "none"}; budget: ${d.budget ? budgetText(d.budget) : "none"}` },
];

const LOT_FIELDS: InventoryLotField[] = ["product_form", "grade_raw", "standard_id", "standard_edition", "thickness_mm", "width_mm", "total_kg", "piece_count", "condition", "certificate_claims", "available_from", "price_amount", "price_currency", "price_basis", "incoterm", "incoterm_place", "surplus_reason"];

export function buildFacts(checks: Check[], demand: Demand, lot: InventoryLot): Fact[] {
  const facts: Fact[] = checks.map((c) => ({ id: `C-${c.id}`, text: `${c.label}: ${c.status.toUpperCase()} — ${c.detail}` }));
  facts.push(...DEMAND_FACTS(demand));
  for (const f of LOT_FIELDS) {
    const o = lot.fields[f];
    const v = o.normalized_value;
    const empty = v === null || (Array.isArray(v) && v.length === 0);
    facts.push({ id: `L-${f}`, text: `Lot ${f.replaceAll("_", " ")}: ${empty ? "UNKNOWN" : Array.isArray(v) ? v.join(", ") : String(v)}${o.status.startsWith("user_") ? " (owner reviewed)" : ""}` });
  }
  return facts;
}

const SYSTEM = `You explain one steel-stock candidate to a trader who will decide whether it is worth an enquiry.

You receive a numbered list of FACTS produced by deterministic rules. They are the only things you may say.
Rules:
1. Every sentence cites the fact IDs it relies on in fact_ids. A sentence you cannot support with the facts must not be written.
2. Do not change any rule result. A FAIL stays a failure, an UNKNOWN stays unknown, a REVIEW needs engineering review.
3. Never say a grade is equivalent to, compatible with, or a substitute for another grade. Never say anything is certified, guaranteed, approved, verified or safe to use.
4. Do not add numbers, prices, freight, dates or standards that are not in the cited facts. Do not estimate profit.
5. summary: one or two sentences on why this candidate was surfaced and its overall status.
6. supported_facts: what is satisfied. differences_and_unknowns: what fails, differs or is unknown. next_questions: concrete questions, each addressed to seller, buyer or engineering.
7. Be brief and plain. English.`;

export function buildExplainMessages(facts: Fact[], status: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Overall rule status: ${status}\nFACTS:\n${facts.map((f) => `[${f.id}] ${f.text}`).join("\n")}` },
  ];
}

// Claims the model must never make: substitution, conformity, certification,
// guarantees. Negated forms ("not verified", "unverified") are allowed.
const FORBIDDEN =
  /\b(equivalen\w*|interchangeab\w*|compatib\w*|substitut\w* for|in place of|instead of|same as|can (?:replace|be used|substitute)|could (?:replace|be used)|replaces?|conform\w*|compl(?:y|ies|iant)|meets? (?:the )?(?:standard|spec\w*|requirement\w*)|certified|certifies|guarantee\w*|approved|verified|validated|safe to use|will (?:arrive|deliver|ship)|(?:acceptable|suitable|good|valid) (?:alternative|substitute|replacement)|suitable for|equal to|equals|satisf\w* the (?:buyer|demand|requirement)\w*|fit for (?:purpose|use))\b/i;
const NEGATED = /\b(?:not|never|un|no|without)[\s-]*(?:verified|validated|approved|certified)\b|\bunverified\b/gi;
const NUMBER_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|half|dozen|couple)\b/i;
const AMBIGUOUS_NUMBER = /\d,\d{1,2}(?!\d)/; // "5,41": decimal comma, never compared, so not allowed

export interface CheckedExplanation {
  explanation: Explanation;
  dropped: { text: string; reason: string }[];
}

/** Deterministic post-check: keep only sentences that cite real facts and add nothing to them. */
export function checkExplanation(raw: Explanation, facts: Fact[]): CheckedExplanation {
  const byId = new Map(facts.map((f) => [f.id, f.text]));
  const dropped: CheckedExplanation["dropped"] = [];
  const ok = (text: string, ids: string[]): boolean => {
    const reason =
      ids.length === 0
        ? "no fact cited"
        : ids.some((id) => !byId.has(id))
          ? `unknown fact ${ids.find((id) => !byId.has(id))}`
          : FORBIDDEN.test(text.replace(NEGATED, ""))
            ? "certification or equivalence language"
            : NUMBER_WORDS.test(text) || AMBIGUOUS_NUMBER.test(text)
              ? "number not in cited facts"
            : numbersIn(text).some((n) => !ids.some((id) => numbersIn(byId.get(id)!).some((m) => Math.abs(m - n) < 1e-9)))
              ? "number not in cited facts"
              : null;
    if (reason) dropped.push({ text, reason });
    return reason === null;
  };
  return {
    explanation: {
      summary: ok(raw.summary.text, raw.summary.fact_ids) ? raw.summary : { text: "", fact_ids: [] },
      supported_facts: raw.supported_facts.filter((s) => ok(s.text, s.fact_ids)),
      differences_and_unknowns: raw.differences_and_unknowns.filter((s) => ok(s.text, s.fact_ids)),
      next_questions: raw.next_questions.filter((q) => ok(q.question, q.fact_ids)),
    },
    dropped,
  };
}
