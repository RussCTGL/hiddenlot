# Contributions

Everything below was built during the hackathon window (from 2026-10-26).
Commit history is the primary record.

## Log

| Date | Who | New during hackathon | Third-party used | In demo |
|---|---|---|---|---|
| 2026-10-26 | RussCTGL | Project scaffold; Meta API adapter with server-only guard; HRC schema v0.1; unit normalization; ExtractSupply prompt v1 and post-checks; synthetic probe fixture with expected values; Meta probe script; offline tests | Next.js 16.4.3, React 19.3, Tailwind CSS 4, zod 4.6, server-only, tsx (all MIT) | Extraction (yes) |
| 2026-10-26/27 | RussCTGL | Postgres schema and data layer; deterministic constraint engine (plan §11) and review-priority score; event-driven, authorization-first discovery with invalidation; shared-listing projection; review workflow; CSV/XLSX/PDF parsers with cell/page locators and limits; evidence integrity checks (token boundaries, cell scoping, cross-row/cross-lot, dates, units, currency); regex baseline B1; intake pipeline with dedupe; ExplainCandidate with citation checks; synthetic three-network demo and held-out eval set; evaluation scripts; web UI (overview, intake & review, inventory, demands, opportunities, sharing) | PGlite (Apache-2.0), exceljs (MIT), pdfjs-dist (Apache-2.0), pdf-lib (MIT, dev) | Yes |

## Not counted as hackathon work

- `create-next-app` boilerplate (first commit), and the Next-generated `AGENTS.md` and `next-env.d.ts`.
- Domain knowledge and the product idea, which predate the event.
