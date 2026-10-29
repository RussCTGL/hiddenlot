# Architecture

```
seller document (text / CSV / XLSX / text PDF)
  │  src/ingestion/{text-fragments,tabular,pdf}.ts — split into lines/rows/PDF lines with IDs and exact locators;
  │                                                  limits, hidden sheets/rows/cols skipped, no macros/scripts
  ▼
Meta Muse Spark · ExtractSupply (src/ai/tasks/extract-supply.ts)
  │  strict JSON Schema output: every value comes with the raw text it was read from and fragment IDs
  ▼
deterministic post-checks (same file)
  │  quote must exist in the cited fragment on token boundaries, inside one table cell
  │  value must appear in the cell value; unit must be written; dates must match y/m/d
  │  lots may only cite their own row / section; units converted in code (src/domain/units.ts)
  │  anything that fails → Unknown with an issue code; instructions in the document → ignored_instructions
  ▼
owner review & publish (src/workflow/actions.ts) — confirm / correct (new immutable version), publish
  │
  ▼  event: lot or demand changed, grant created/revoked, or any read (time-based expiry)
discovery (src/discovery/engine.ts)
  │  universe = own published lots + lots shared under a live grant (built BEFORE matching)
  │  shared lots are projected: withheld fields → Unknown; no quotes, files, source IDs or reviewer identity
  ▼
constraint engine (src/discovery/constraints.ts) — pass / fail / unknown / review / conditional per check,
  │  in plan §11.3 order; no grade-equivalence table; a known fail always wins
  ▼
status: evidence_supported · declared_match · conditional_candidate · engineering_review_required ·
        insufficient_evidence · incompatible (kept as a trace, never shown as a candidate)
  │  review-priority score (src/discovery/score.ts): known parts only, with coverage and a range
  ▼
opportunity (immutable assessment keyed by lot/demand/permission/rules versions + freshness)
  │  invalidated on sale, withdrawal, new version, revoke, expiry or stale stock
  ▼
buyer review (shortlist / request info / dismiss, with reason and versions) — nothing is sent or reserved
  │
  ├─ daily digest (src/workflow/deals.ts · buildDigest): computed on request from assessments, deals and the clock;
  │    drawn on a server-projected SVG map (src/geo: Natural Earth land, built-in port list — no map service);
  │    pins use shared fields only: stock location, else loading port (FOB…), else delivery port (CFR…)
  │    move forward (all hard checks pass) · needs an answer (≤ 2 seller questions) · deal risks;
  │    drafts built from the shared projection only; accepting re-computes the digest and runs only suggestions that still exist
  ├─ deals (table `deals`, one open deal per demand × lot pair, survives re-assessment):
  │    waiting → quote requested → quote in hand → negotiating → won / lost; history in `deal_events`;
  │    auto-closed as lost when the lot is sold or withdrawn, sharing ends, or the demand ends
  │
  └─ optional Meta · ExplainCandidate (src/ai/tasks/explain-candidate.ts): rephrases rule results;
     every sentence must cite fact IDs; unsupported numbers / equivalence / certification language removed;
     only if the lot owner's grant allows model processing
```

## Storage

Postgres schema in `db/migrations/` (`0001_init.sql`; `0002_deals.sql` adds deals, deal events and the demo
clock; `0005_hosted.sql` adds per-visitor Meta usage and maintenance leases), run on embedded PGlite
locally (`.data/pglite`) and on Neon Postgres over HTTPS when `DATABASE_URL` is set (`src/db/neon.ts`). Both
sit behind the same three-method interface in `src/db/client.ts`. Raw documents
stay with the owner network; other networks only ever receive the shared projection.

## Authorization

`src/auth/access.ts` is the only path that crosses network boundaries. Every list and detail read re-checks the
actor's network and the live grant; documents of another network return "not found". Server actions re-read the
session and pass the actor to the workflow layer, which checks ownership again.

## What is deliberately not modelled

Transit time, freight, duty, FX, certificate authenticity, heat-number ↔ certificate linkage (document gate),
offer validity. These show as Unknown or "not checked", never as a pass.
