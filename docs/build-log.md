# Build log

Phase-gated build, started 2026-10-26 (hackathon day 1). Every phase ends with
a gate: typecheck, lint, the full test suite, the phase's own acceptance tests,
and a separate review pass against the project plan by a reviewer who did not
write the code under review. A phase is only
closed when the gate passes; review findings are fixed and re-checked first.

Decisions taken without waiting for input are marked **Decision** with the
reason, so they can be revisited.

## Phases

| Phase | Scope | Gate |
|---|---|---|
| P1 Core engine | Postgres schema, constraint engine, review-priority score, event-driven discovery, server-side authorization, review workflow | §11.4 dangerous negatives as tests; permission and invalidation tests on a real database; separate review pass |
| P2 Ingestion | Text / CSV / XLSX / text-PDF parsing with cell and page locators, regex baseline (B1), intake pipeline with Meta extraction | Parser and locator tests; baseline vs fixture; one live Meta run on a table; review |
| P3 Synthetic data | Three fictional networks, canonical truth, rendered multi-format documents, seed and reset | Seed runs clean; discovery outcome matches every canonical label; review |
| P4 UI | Intake & review, inventory, demands, opportunity feed and detail, sharing | `next build`; demo flow walked in a browser; review |
| P5 Evaluation | B1 vs B3 field accuracy, safety suite, permission suite, results file | Scripts reproduce the numbers; review |
| P6 Docs | README, architecture, evaluation, demo script, third-party notices, contributions | Clean-copy run of the README steps |

## Decisions

- **Decision (P1): embedded PGlite instead of a hosted database for now.** The
  plan suggests PostgreSQL/Supabase. PGlite runs real Postgres SQL in-process,
  so `db/migrations` stays portable to a hosted Postgres for deployment, and the
  build needs no external account tonight.
- **Decision (P1): `product_form` became an extracted field (schema 0.2.0).**
  Needed so a plate offered against a coil demand fails on product form
  (§11.4) instead of being assumed to be a coil.
- **Decision (P1): status semantics.** `evidence_supported` requires every hard
  check to pass on reviewed fields with no requirement resting only on a seller
  claim. A required certificate is always a seller claim until a document check
  exists, so such candidates are `declared_match` ("declared spec match").
- **Decision (P1): demand-side nulls.** A buyer range left empty is Unknown and
  asks the buyer; a missing need-by date or budget means "not required" and is
  shown as such.

## Gate results

### P1 — passed (2026-10-27)
- First gate: typecheck and lint clean, 59/59 tests, but the separate review pass **failed** the phase:
  1 blocker, 6 majors, 4 minors.
  - Blocker: the shared view leaked withheld fields through evidence quotes and raw text.
  - Majors:
    - values were visible again through the score after revocation;
    - time-based expiry (grant, demand, stock freshness) never invalidated anything;
    - assessments were rewritten in place, so a shortlist survived on stale stock;
    - an engineering-review candidate could be shortlisted;
    - certificate claims matched by substring ("NO MTC" passed);
    - an unknown availability date could reach evidence_supported.
- Fixes:
  - redacted shared-listing projection (`owner_private` evidence);
  - masked views after access ends;
  - re-evaluation on every read;
  - immutable assessments keyed by freshness;
  - shortlisting limited to reviewable groups;
  - exact certificate names;
  - `not_required` basis;
  - exact decimal money;
  - deterministic grant precedence;
  - corrections drop source evidence;
  - thickness sanity bound 25.4 mm.
  
  Each finding has a regression test.
- Re-review: **PASS**, every fix confirmed by the reviewer's own probe scripts. 88/88 tests.
- Accepted minors, logged for later:
  - Opaque network IDs (`net-b`) stay visible to recipients. The alias is shown anyway; blank them if IDs ever become meaningful.
  - Reads re-run discovery (a write per page view). Fine at the plan's data size (§12.1).
  - Heat-number/certificate mismatch is `not_checked` until the document gate (plan P1 scope, §16.2).
  - Offer validity / expired quotes: no field yet.

### P2 — passed (2026-10-27, 4 review rounds)
- Round 1 failed: 2 blockers, 4 majors.
  - Blockers:
    - a failed import was reported as passing and never retried;
    - evidence matched substrings, so "15" could be read from "1500" and "235" from "Q235B".
  - Majors:
    - no cross-row check;
    - dedupe merged on the reference plus unknown specs;
    - limits could be bypassed (per-sheet rows, wide rows, PDF O(n²), zip bombs);
    - a corrupt PDF page crashed intake.
- Round 2 failed:
  - blocker: values were checked against the whole quote, so "Q235" from "Grade: Q235B" and a day/month swap both passed;
  - majors: the zip guard trusted declared sizes; there was no cross-lot check for text/PDF.
- Round 3 failed:
  - cross-lot sections came from the model's own lot list;
  - non-ISO dates skipped the month;
  - a 2.9 MB workbook could take 1.6 GB of memory.
- Round 4 **PASS**. Two residual minors fixed after the pass: bare-reference sections, and a month name needs an adjacent day.
- What the final rules are:
  - evidence spans must sit on token boundaries and inside one table cell;
  - a value is checked against the cell value, never the header;
  - units must be written (glued to a number is fine, inside a word is not);
  - currencies must be written;
  - dates must match year, month and day, and day/month-swappable dates are Unknown;
  - a lot may cite only its own row or section (sections come from the document);
  - dedupe requires reference, grade, size and weight to all be known and equal, otherwise the lot is flagged as a possible duplicate;
  - per-file limits: 100 table rows, 400 lines, 4,000 characters per line, 4 MB of real inflated XLSX, 400 XML rows, 20 pages, 5,000 items per page;
  - hidden sheets, rows and columns are skipped and reported;
  - re-uploading a failed import retries it.
- Live Meta on the 4 demo documents:
  - critical fields: B3 81/81 (prompt v2) and 75/81 (prompt v3), B1 79/81;
  - both 18/18 on Unknowns, 0 fabricated.
  - One run missed lot B-030 entirely; this is run-to-run variance that P5 has to measure, not hide.
- **Caveat:** B1's regexes were written with these documents in view, so they are development data, not a held-out test.
- 117/117 tests.

### P3 — passed (2026-10-27, 2 review rounds)
- The reviewer derived all 22 demand × lot labels independently from the plan's rules, without looking at the matcher.
- Round 1: 21/22 agreed.
  - Major: C-101 (SS400 under KS D3503 against a JIS G3101 demand that allows review) was labelled incompatible. It is a substitution, so engineering review. The engine failed any standard mismatch regardless of policy; fixed in `standardCheck`, now covered by tests.
  - Major (demo optics): the planted "approve this deal" line sat in the section of the only evidence-supported lot. Moved to the plate lot B-030; canonical truth now records it as an ignored instruction.
  - Minors fixed:
    - the seed review is audited as scripted, not human;
    - the need-by label now says "ex-warehouse, transit not modelled";
    - two raw strings tightened.
- Round 2 **PASS**; all 22 labels agree.
- Known: seed freshness uses the wall clock, so reseed within 48 h of recording a demo.

### P4 — passed (2026-10-27, 2 review rounds)
- Browser walk-through of the demo story on the dev server, using live Meta:
  - Meta explanation with fact citations;
  - shortlist with a reason;
  - switch to Network B → mark sold;
  - back as A → opportunity invalidated, details hidden;
  - as B → upload a new offer, Meta extraction (9 s), confirm, publish;
  - as A → the new lot appears automatically as a declared match.
- Round 1, no blockers. Confirmed with forged server-action POSTs and payload greps: no cross-network write and no leak of names, quotes or raw text.
  - Majors:
    - uploads over 1 MB crashed while the UI promised 10 MB;
    - the explanation filter missed substitution and conformity wording ("in place of", "compatible", "conforms").
  - Minors:
    - list and detail status disagreed after the rule change (stale `rules.v1` assessments);
    - six actions surfaced raw errors;
    - Zod and database errors were shown verbatim;
    - `field in shape` accepted prototype keys;
    - no UI for model-processing consent;
    - §7.3 gaps (wording difference, freight, lot identity);
    - "owner reviewed" wording was ambiguous;
    - no limits on paid calls or public reset.
  - All fixed: rules version bumped to `rules.v2`.
- Round 2 **PASS**. Residuals fixed after the pass:
  - more claim phrases in the explanation filter;
  - the rate limit counts attempts;
  - the seeded B→A grant withholds the warehouse location and heat numbers.
- Production build clean, 120/120 tests.

### P5 — evaluation (in review)
- Held-out sets generated from fixed seeds. Each prompt change made after seeing test errors was scored only on a newly generated set:
  - v3 → eval;
  - v4 (a trailing unit applies to the whole dimension expression) → eval2;
  - v5 (certificate names, not phrases) → eval3.
- Results:
  - **Extraction:** B3 Meta 230/255 → 242/258 → 239/263, against B1 226/255, 225/258, 235/263. Zero fabricated values for both systems on every set.
  - **Discovery:** B3 recall 8/8 on eval2 and eval3, against B1's 4/8 and 6/8. Zero hard-constraint violations.
  - **Ablation A1 (no hard constraints):** 53/60 and 54/60 of the top-5 candidates violate a known requirement.
- Failure found: Meta skips whole lots (3/36 per set); on eval3, all 24 of its critical-field misses were in skipped lots. Added a deterministic missed-lot warning; it changes no score.
- Generator bugs found and fixed on the way:
  - "3." number formatting;
  - CJK units in PDFs;
  - demands contradicting their own base lot. Documents stayed byte-identical; noted in the evaluation doc.

### P6 — docs and clean run (in review)
- README, architecture, evaluation, demo script, third-party notices, contributions.
- Clean copy (no node_modules, build output, database or key):
  - `npm ci`, 120/120 tests, `next build` and `db:seed` all passed;
  - `npm run typecheck` failed on fresh route types and was fixed (`next typegen && tsc`).
- **Bug found during P5:** a Meta call that timed out while its response body was being read threw out of the client instead of being recorded as a `timeout` run, and it crashed the eval run. Body reads are now guarded: a timeout is retried within the retry bound, and a non-JSON body is recorded as `invalid_output`. Regression test added. Evaluation runs use a 120 s per-call timeout; the app default stays 60 s.
- **Post-check gap found during P5, on eval4:** lot sections did not start at "Ref D-100" / "编号 D-100" lines, so the cross-lot check missed values taken from neighbouring lots. Fixed for both extractors. On the earlier sets, B1's numbers are unchanged after the fix.

### P5 — passed (2026-10-27, 3 review rounds)
- Round 1:
  - Blocker: prompts v4 and v5 quoted the generator's own phrases, so eval2 and eval3 were not independent of those changes.
  - Majors:
    - "skipped lots" were all plates, because the prompt said HRC;
    - abstention was guaranteed by construction;
    - the data table was stale;
    - statistical caveats were missing.
  - Fixed:
    - prompt v6 (every product form, examples not taken from any template);
    - template family B and the eval4 set;
    - a measured "claimed where truth is Unknown / caught" metric;
    - run metadata in result files;
    - a rewritten evaluation doc.
- Round 2: one major. The doc understated the two scoring-code changes made while looking at B1's eval4 output (B1 0 → 59 → 32/261; Meta had not run yet). Now stated exactly. **PASS** after the wording fix.
- Clean result (eval4, prompt v6, single run):
  - critical fields: B3 261/261, B1 32/261;
  - claims where truth is Unknown: B3 21, all caught by the checks; B1 7, all caught;
  - recall: B3 9/9, B1 0/9; 0 violations;
  - A1 without hard constraints: 48/60 violate a known requirement.

### P6 — content passed; publishing is blocked on the user's decisions
- Docs verified against code and result files. README commands work offline on a clean copy.
- Not done, because each is the user's call, and each must be settled before the repo is made public:
  - commit the work (nothing since 2026-10-26 22:48 is committed);
  - AI-tool disclosure;
  - a license for code and data.
- Settled 2026-10-28: all rights reserved (no open-source license; `LICENSE` says so); a one-line note that the code was written with AI coding assistance; commit author email rewritten to the GitHub noreply address before the first push (every commit hash changed; `CONTRIBUTIONS.md` and `evals/results/README.md` list the new ones).

### Global map and a second region (2026-10-28)
- The Today map was framed on East and Southeast Asia, and any port outside it was dropped. Now:
  - the base map is the whole world (Mercator, 56°S–75°N), opening on the day's pins and delivery ports, wherever they are;
  - the page draws the 1:110m coastline; the 1:50m one is fetched once from `/map/land` and cached by the browser;
  - the port gazetteer covers the Americas, Europe, the Middle East, South Asia, Africa and Oceania. Common words (Mobile, San Antonio, Valencia) only match with a qualifier.
- Demo data `demo-v3` adds Network D, a buyer in Houston, and Network E, a stockist with yards in New Orleans, Altamira, Antwerp and Rotterdam. E's offers are written in inches, pounds and "tons"; all 7 new pairs reproduce their hand labels through the real pipeline.
- Drafts read sizes and weights back in the seller's units ("0.118 × 60 in, 39,683 lbs / 18 t"). An ambiguous "tons" asks the seller "metric tonnes or short tons?" without quoting their private text.

### Hosted database for a public deployment (2026-10-29)
- The embedded database cannot serve a serverless host: each instance would get its own copy, and it is lost when the instance stops. Rather than rewrite any SQL, the three-method database interface got a second implementation on Neon's serverless driver:
  - a single query is one HTTPS request;
  - a transaction is a WebSocket session opened and closed inside it.
- The embedded database is now loaded only when `DATABASE_URL` is unset, so the Vercel build leaves it out.
- Several instances can now start at once:
  - migrations run in one transaction under an advisory lock;
  - first-start seeding and the daily reload take a lease in `maintenance_leases`;
  - the public cron route reloads at most once per 20 hours.
- Meta calls are capped per visitor as well as per day. A visitor is a hash of the day and client address; addresses are not stored.
- Uploads are limited to 4 MB on Vercel, which refuses larger request bodies.
- The test suite can run unchanged against hosted Postgres (`npm run test:hosted`).

### Map zoom, sign-in accounts and a simulated market (2026-10-29)
- The Today map zooms with the mouse wheel and trackpad pinch around the cursor, with a double-click, and with a two-finger pinch on touch screens. The view's centre stays on the world.
- Sign-in replaces the open "Acting as" switcher:
  - each demo user has a username and a scrypt password hash;
  - a session is a random token in an HTTP-only cookie, stored only as its SHA-256 and valid for 7 days;
  - sessions survive the daily demo reload, because users keep their ids.
- Six simulated users in the existing networks and a new Network F (Jebel Ali), with grants from B, C and E:
  - a seeded, deterministic simulator has them post stock (bilingual text, inch/pound text, CSV) through the real intake, post demands, answer buyers' questions by correcting their own lots, and sell;
  - every simulated document passes the evidence checks: its truth is written with it, so extraction is scripted and makes no model calls;
  - live stock and demands from the simulator are capped per network.
- **Activity** shows a network its own events in full and a one-line summary from networks that share stock with it; demands are never shared.
- Tests: accounts and sessions, the answer flow (E-305 "20 tons" → 20 t, Dana's deal sees it), 48 steps through the pipeline within the caps, feed visibility, and determinism.
