import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateConstraints, type AccessContext } from "@/discovery/constraints";
import { scoreCandidate } from "@/discovery/score";
import { demand, lot, NOW } from "./helpers";

// Safety suite, constraint layer (plan §11.4). Each test names the row of the
// dangerous-negatives table it covers.

const own: AccessContext = { own: true, grant_id: null, withheld: [] };
const shared: AccessContext = { own: false, grant_id: "grant_x", withheld: [] };
const run = (l = lot(), d = demand(), a = shared) => evaluateConstraints(l, d, a, NOW);
const check = (r: ReturnType<typeof run>, id: string) => r.checks.find((c) => c.id === id)!;

test("main demo case: same grade and stated standard is a declared match (MTC is a seller claim)", () => {
  const r = run();
  assert.equal(r.compatibility_status, "declared_match");
  assert.equal(check(r, "certificates").basis, "seller_claim");
  assert.equal(check(r, "heat_link").status, "not_checked");
});

test("evidence_supported needs reviewed fields and no claim-only requirement", () => {
  const r = run(lot(), demand({ must_have_certificates: [] }));
  assert.equal(r.compatibility_status, "evidence_supported");
  const unreviewed = lot();
  unreviewed.fields.thickness_mm = { ...unreviewed.fields.thickness_mm, status: "normalized" };
  assert.equal(run(unreviewed, demand({ must_have_certificates: [] })).compatibility_status, "declared_match");
});

test("§11.4 SS400 required, substitution forbidden, Q235B offered → incompatible", () => {
  const r = run(lot({ grade_raw: "Q235B", standard_id: "GB/T 700" }), demand({ substitution_policy: "forbidden" }));
  assert.equal(r.compatibility_status, "incompatible");
  assert.equal(check(r, "grade").status, "fail");
});

test("§11.4 substitution allowed but only the name S235JR → engineering review, never a match", () => {
  const r = run(lot({ grade_raw: "S235JR", standard_id: "EN 10025-2" }));
  assert.equal(r.compatibility_status, "engineering_review_required");
  assert.equal(check(r, "grade").ask, "engineering");
});

test("§11.4 same grade, edition required but not stated → insufficient evidence (no invented edition)", () => {
  const r = run(lot({ standard_edition: null }), demand({ accepted_grades: [{ grade: "SS400", standard_id: "JIS G3101", edition: "2020" }] }));
  assert.equal(r.compatibility_status, "insufficient_evidence");
  assert.equal(check(r, "standard").status, "unknown");
});

test("the same grade name under another standard is a substitution: fail if forbidden, engineering review otherwise", () => {
  const forbidden = run(lot({ standard_id: "KS D3503" }), demand({ substitution_policy: "forbidden" }));
  assert.equal(forbidden.compatibility_status, "incompatible");
  assert.equal(check(forbidden, "standard").status, "fail");
  const review = run(lot({ standard_id: "KS D3503" }));
  assert.equal(review.compatibility_status, "engineering_review_required");
  assert.equal(check(review, "standard").ask, "engineering");
});

test("grade labels ignore case and spacing only", () => {
  assert.equal(check(run(lot({ grade_raw: "ss 400" })), "grade").status, "pass");
  assert.equal(check(run(lot({ grade_raw: "SS490" })), "grade").status, "review");
});

test("§11.4 3.0 read as 30 → thickness fails instead of matching", () => {
  assert.equal(check(run(lot({ thickness_mm: 30 })), "thickness").status, "fail");
});

test("§11.4 3 mm coil offered as 3 mm plate → product form fail", () => {
  const r = run(lot({ product_form: "hot_rolled_plate" }));
  assert.equal(r.compatibility_status, "incompatible");
  assert.equal(check(r, "product_form").status, "fail");
});

test("§11.4 buyer needs 20 t, no partial delivery, lot is 18 t → quantity fail (no invented top-up)", () => {
  const d = demand({ quantity_kg: { min: 20000, target: 20000, max: 20000 }, allow_multi_lot: true });
  const r = run(lot(), d);
  assert.equal(r.compatibility_status, "incompatible");
  assert.match(check(r, "quantity").detail, /not combined automatically/);
});

test("partial delivery allowed → conditional, not a full match", () => {
  const d = demand({ quantity_kg: { min: 20000, target: 20000, max: 25000 }, allow_partial_delivery: true });
  assert.equal(run(lot(), d).compatibility_status, "conditional_candidate");
});

test("one 18 t coil cannot be sold as 15 t", () => {
  const d = demand({ quantity_kg: { min: 10000, target: 15000, max: 15000 } });
  assert.equal(check(run(lot({ piece_count: 1 }), d), "quantity").status, "fail");
  assert.equal(check(run(lot({ piece_count: 3, splittable: null }), d), "quantity").status, "unknown");
});

test("§11.4 available after need-by → fail", () => {
  const r = run(lot({ available_from: "2026-12-15" }));
  assert.equal(r.compatibility_status, "incompatible");
  assert.equal(check(r, "available_date").status, "fail");
});

test("§11.4 stale stock confirmation → needs refresh, not a match", () => {
  const r = run(lot({}, { last_verified_at: "2026-10-20T00:00:00.000Z" }));
  assert.equal(r.compatibility_status, "insufficient_evidence");
  assert.equal(check(r, "freshness").status, "unknown");
});

test("sold or withdrawn lots fail even if every spec matches", () => {
  assert.equal(run(lot({}, { status: "sold" })).compatibility_status, "incompatible");
  assert.equal(run(lot({}, { status: "withdrawn" })).compatibility_status, "incompatible");
});

test("§11.4 rejected stock without stated defects → condition unknown", () => {
  const d = demand({ acceptable_conditions: ["prime", "rejected_on_arrival"] });
  const r = run(lot({ condition: "rejected_on_arrival", defect_notes: null }), d);
  assert.equal(check(r, "condition").status, "unknown");
  assert.equal(r.compatibility_status, "insufficient_evidence");
});

test("unstated condition is unknown: surplus does not imply prime", () => {
  assert.equal(check(run(lot({ condition: null })), "condition").status, "unknown");
});

test("ambiguous 'ton' left total weight unknown → insufficient evidence, never a pass", () => {
  const l = lot({ total_kg: null });
  l.fields.total_kg = { ...l.fields.total_kg, status: "unresolved", raw_value: "22 ton", issues: ["ambiguous_ton"] };
  const r = run(l);
  assert.equal(check(r, "quantity").status, "unknown");
  assert.equal(r.compatibility_status, "insufficient_evidence");
});

test("a known fail is never outweighed: fail + unknowns + perfect score is still incompatible", () => {
  const l = lot({ product_form: "cold_rolled_coil", standard_id: null, condition: null });
  assert.equal(run(l).compatibility_status, "incompatible");
});

test("fields withheld by the owner are Unknown for the recipient, with no value leaked into the trace", () => {
  const a: AccessContext = { own: false, grant_id: "grant_x", withheld: ["grade_raw", "standard_id", "standard_edition"] };
  const r = run(lot({ grade_raw: "SECRET-GRADE" }), demand(), a);
  assert.equal(check(r, "grade").status, "unknown");
  assert.ok(!JSON.stringify(r).includes("SECRET-GRADE"));
});

test("buyer with no range set is asked, not assumed to accept anything", () => {
  const r = run(lot(), demand({ width_mm: { min: null, max: null, source: "buyer_explicit" } }));
  assert.equal(check(r, "width").status, "unknown");
  assert.equal(check(r, "width").ask, "buyer");
});

test("own-network lots are labelled as such", () => {
  assert.match(check(run(lot(), demand(), own), "access").detail, /own network/);
});

test("score: unknown dimensions are excluded, interval and coverage reported", () => {
  const s = scoreCandidate(lot(), demand(), NOW);
  assert.ok(s.coverage > 0 && s.coverage <= 1);
  assert.ok(s.lower! <= s.observed! && s.observed! <= 100);
  assert.ok(s.upper! >= s.lower!);
  assert.equal(s.commercial, "within_budget");
  const noBudget = scoreCandidate(lot(), demand({ budget: null, need_by: null }), NOW);
  assert.equal(noBudget.components.economics.value, null);
  assert.equal(noBudget.components.delivery.value, null);
  assert.ok(noBudget.coverage < s.coverage);
});

test("score: prices on a different Incoterm basis are not compared", () => {
  const s = scoreCandidate(lot({ incoterm: "FOB", incoterm_place: "Busan" }), demand(), NOW);
  assert.equal(s.commercial, "unknown");
  assert.equal(s.components.economics.value, null);
});

test("score: price comparison uses exact decimal cents", () => {
  assert.equal(scoreCandidate(lot({ price_amount: "560.01" }), demand(), NOW).commercial, "over_budget");
  assert.equal(scoreCandidate(lot({ price_amount: "560.00" }), demand(), NOW).commercial, "within_budget");
});

// --- P1 review regressions -------------------------------------------------

test("negative or partial certificate claims never satisfy a requirement", () => {
  assert.equal(check(run(lot({ certificate_claims: ["NO MTC available"] })), "certificates").status, "unknown");
  const d = demand({ must_have_certificates: ["EN 10204 2"] });
  assert.equal(check(run(lot({ certificate_claims: ["EN 10204 2.1"] }), d), "certificates").status, "unknown");
  assert.equal(check(run(lot({ certificate_claims: ["mtc"] })), "certificates").status, "pass");
});

test("no need-by date and no stated availability date is never evidence_supported", () => {
  const d = demand({ need_by: null, must_have_certificates: [] });
  assert.equal(run(lot({ available_from: null }), d).compatibility_status, "declared_match");
  assert.equal(run(lot(), d).compatibility_status, "evidence_supported");
});

test("§11.4 a value flagged implausible at extraction (30 mm) asks for a recheck instead of matching", () => {
  const l = lot({ thickness_mm: 30 });
  l.fields.thickness_mm = { ...l.fields.thickness_mm, issues: ["implausible_thickness_mm:30"] };
  const r = run(l, demand({ thickness_mm: { min: 1, max: 40, source: "buyer_explicit" } }));
  assert.equal(check(r, "thickness").status, "unknown");
  assert.match(check(r, "thickness").detail, /implausible/);
});

test("money: exact decimal comparison; zero budget is unknown", () => {
  assert.equal(scoreCandidate(lot({ price_amount: "560.009" }), demand(), NOW).commercial, "over_budget");
  const zero = demand({ budget: { amount: "0", currency: "USD", basis: "per_mt", incoterm: "CFR", place: "Haiphong" } });
  const s = scoreCandidate(lot(), zero, NOW);
  assert.equal(s.commercial, "unknown");
  assert.ok(s.observed === null || Number.isFinite(s.observed));
});

test("a different edition of the right standard: fail if substitution forbidden, review otherwise", () => {
  const want = { accepted_grades: [{ grade: "SS400", standard_id: "JIS G3101", edition: "2020" }] };
  const l = lot({ standard_edition: "2015" });
  assert.equal(check(run(l, demand({ ...want, substitution_policy: "forbidden" })), "standard").status, "fail");
  assert.equal(check(run(l, demand(want)), "standard").status, "review");
  assert.equal(check(run(lot({ standard_edition: "2020" }), demand(want)), "standard").status, "pass");
});
