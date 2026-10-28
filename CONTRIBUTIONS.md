# Contributions

Everything below was built during the hackathon window (from 2026-10-26).
Commit history is the primary record. The code was written with AI coding assistance; design, review and decisions are the author's.

## Log

| Date | Who | New during hackathon | Commits | Third-party used | In demo |
|---|---|---|---|---|---|
| 2026-10-26 | RussCTGL | Project scaffold; Meta API adapter with server-only guard; HRC schema v0.1; unit normalization; ExtractSupply prompt v1 and post-checks; synthetic probe fixture with expected values; Meta probe script; offline tests | `6713000`, `ecf6138` | Next.js 16.4.3, React 19.3, Tailwind CSS 4, zod 4.6, server-only, tsx (all MIT) | Extraction (yes) |
| 2026-10-26/27 | RussCTGL | **P1 core engine:** Postgres schema and data layer; deterministic constraint engine (plan §11) and review-priority score; authorization-first, event-driven discovery with invalidation; shared-listing projection; review workflow | `dbd78c1` | PGlite (Apache-2.0) | Yes |
| 2026-10-26/27 | RussCTGL | **P2 ingestion:** CSV/XLSX/PDF parsers with cell/page locators and limits; evidence integrity checks (token boundaries, cell scoping, cross-row/cross-lot, dates, units, currency, missed lots); ExtractSupply prompt v6; regex baseline B1; intake pipeline with dedupe | `42e2d26` | exceljs (MIT), pdfjs-dist (Apache-2.0) | Yes |
| 2026-10-26/27 | RussCTGL | **P3 dataset:** synthetic three-network demo (hand-written truth, rendered documents, labels for 22 pairs) and seed through the real pipeline | `12166b3` | pdf-lib (MIT, dev) | Yes |
| 2026-10-26/27 | RussCTGL | **P4 UI:** overview, intake & review, inventory, demands, opportunity feed and detail, sharing; server actions; ExplainCandidate with citation checks | `f596637` | — | Yes |
| 2026-10-26/27 | RussCTGL | **P5 evaluation:** held-out set generator (two template families), extraction and discovery evals, result files, evaluation write-up | `7e49880` | — | Numbers only |
| 2026-10-26/27 | RussCTGL | **P6 docs:** README, architecture, build log, demo script, third-party notices | `591536a` | — | — |
| 2026-10-27 | RussCTGL | **UI redesign:** denser layout, status marks, requirements table, shorter copy | `e4f6df9` | IBM Plex Sans/Mono (OFL 1.1) | Yes |
| 2026-10-27 | RussCTGL | **Volume test and discovery performance:** seeded multi-network generator, independent oracle, `eval:scale`; skip unchanged pairs, one discovery pass per new grant | `551f925`, `d837ec6` | — | Numbers only |
| 2026-10-27 | RussCTGL | **Daily digest and deal tracking:** Today page, deals board and detail, deal risks and auto-close, drafted messages from shared fields, demo clock | `a4af6aa` | — | Yes |
| 2026-10-27 | RussCTGL | **Map-first Today:** server-projected SVG map with pins from shared fields only, port gazetteer, compact decision list, phone menu | `4fe1eae` | d3-geo, topojson-client, world-atlas (ISC; Natural Earth data, public domain) | Yes |

The phase commits group files by build phase in their final state; `docs/build-log.md` records the order of work, each phase's review gate and what it found.

## Not counted as hackathon work

- `create-next-app` boilerplate (first commit), and the Next-generated `AGENTS.md` and `next-env.d.ts`.
- Domain knowledge and the product idea, which predate the event.
