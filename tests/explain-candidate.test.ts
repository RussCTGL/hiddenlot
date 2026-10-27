import assert from "node:assert/strict";
import { test } from "node:test";
import { toStrictJsonSchema } from "@/ai/json-schema";
import { buildFacts, checkExplanation, Explanation } from "@/ai/tasks/explain-candidate";
import { evaluateConstraints } from "@/discovery/constraints";
import { demand, lot, NOW } from "./helpers";

const checks = evaluateConstraints(lot(), demand(), { own: false, grant_id: "g", withheld: [] }, NOW).checks;
const facts = buildFacts(checks, demand(), lot());

test("explanation schema satisfies Meta strict subset", () => {
  assert.doesNotThrow(() => toStrictJsonSchema(Explanation));
});

test("only sentences that cite real facts and add nothing survive", () => {
  const { explanation, dropped } = checkExplanation(
    {
      summary: { text: "SS400 coil of 18 t from a shared network; spec declared to match.", fact_ids: ["C-grade", "C-quantity"] },
      supported_facts: [
        { text: "Thickness 3 mm is within 2.95–3.05 mm.", fact_ids: ["C-thickness"] },
        { text: "Price is about 530 USD.", fact_ids: ["L-price_amount"] }, // number not in fact
        { text: "SS400 is equivalent to Q235B.", fact_ids: ["C-grade"] }, // equivalence
        { text: "Seller is reliable.", fact_ids: [] }, // no citation
        { text: "MTC is certified.", fact_ids: ["C-certificates"] }, // certification language
        { text: "Width fits.", fact_ids: ["C-made-up"] }, // unknown fact
      ],
      differences_and_unknowns: [{ text: "The certificate is a seller claim and the heat link is not checked.", fact_ids: ["C-certificates", "C-heat_link"] }],
      next_questions: [{ to: "seller", question: "Can you send the MTC copy for heat H24-77812?", fact_ids: ["C-heat_link"] }],
    },
    facts,
  );
  assert.equal(explanation.summary.text.startsWith("SS400"), true);
  assert.deepEqual(explanation.supported_facts.map((s) => s.text), ["Thickness 3 mm is within 2.95–3.05 mm."]);
  assert.equal(dropped.length, 6); // 5 bad supported facts + question citing a heat number not in its fact
  assert.ok(dropped.some((d) => d.reason === "certification or equivalence language"));
  assert.ok(dropped.some((d) => d.reason === "number not in cited facts"));
  assert.equal(explanation.differences_and_unknowns.length, 1);
});

test("substitution, conformity and number-word claims are removed; negated verification is fine", () => {
  const bad = [
    "Q235B can be used in place of SS400.",
    "The lot is compatible with the demand.",
    "It conforms to JIS G3101.",
    "It meets the standard.",
    "SS400 is the same as Q235B.",
    "About eighteen tonnes are available.",
    "Price is 5,41 per kg.",
  ];
  const { explanation, dropped } = checkExplanation(
    {
      summary: { text: "The MTC is not verified; it is a seller claim.", fact_ids: ["C-certificates"] },
      supported_facts: bad.map((text) => ({ text, fact_ids: ["C-grade"] })),
      differences_and_unknowns: [],
      next_questions: [],
    },
    facts,
  );
  assert.equal(explanation.summary.text, "The MTC is not verified; it is a seller claim.");
  assert.equal(explanation.supported_facts.length, 0);
  assert.equal(dropped.length, bad.length);
});
