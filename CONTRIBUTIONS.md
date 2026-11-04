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
| 2026-10-28 | RussCTGL | **End-to-end QA fixes:** bugs found in a full pass through every page and action | `bdf43c7` | — | Yes |
| 2026-10-28 | RussCTGL | **Docker:** one container for the whole app, Meta cap per day, hidden reset for public hosting | `427ce7f` | — | No |
| 2026-10-28 | RussCTGL | **Global map and a second region:** world map, global port gazetteer, Networks D and E (Houston, New Orleans, Altamira, Antwerp, Rotterdam), seller's units in drafts | `6ae42ae` | — | Yes |
| 2026-10-29 | RussCTGL | **Public deployment:** Neon Postgres over HTTPS behind the same data interface, multi-instance seeding with leases, daily reload, per-visitor Meta cap; live on Vercel | `e73f5bb`, `4a83aa5` | @neondatabase/serverless (MIT) | Live URL |
| 2026-10-29 | RussCTGL | **Map zoom, sign-in and a simulated market:** wheel/pinch zoom, password accounts with hashed sessions, six simulated users and Network F acting through the real pipeline, Activity feed | `8b892d4` | — | Yes |
| 2026-10-30 | RussCTGL | **Stock map for sellers:** stock desks' Today shows their own lots on the shared pan/zoom map, red when they need reconfirming | `7b1e2fd` | — | Yes |
| 2026-10-31 | RussCTGL | **Review fixes:** one name per status across pages, seller units on Inventory, confirmation before Mark sold / Withdraw / Revoke, labelled form fields, stock-desk empty states, per-page titles and a not-found page; per-lot budgets no longer read as per MT, empty Meta env settings fall back to defaults, the simulator respects grant expiry; docs brought in line with the UI | `2dacf5a` | — | Yes |
| 2026-11-01 | RussCTGL | **Quote request wording:** drafts on a deal say HiddenLot sends nothing to the seller, a requested quote explains the next step, shortlist and request-info messages name the Deals column | `80eb8dd` | — | Yes |
| 2026-11-02 | RussCTGL | **Evidence links and map polish:** each evidence locator links to its source line; a verification summary counts quoted, converted, Unknown, flagged and ignored values; the selected route draws in, lots needing attention pulse (off under reduced motion), frosted map panels, tabular figures | `b16cee2` | — | Yes |
| 2026-11-03 | RussCTGL | **Seller requests and shared orders:** a Requests page where the seller replies, sends an offer or reconfirms the lot; an accepted offer becomes an order both sides share (confirm, contract, payment or L/C, MTC, B/L, receipt) with file sharing; signed-in pages refresh every few seconds; the demo seeds one order at the MTC step | `7ccbec3` | — | Yes |
| 2026-11-03 | RussCTGL | **Order document checks and both accounts at once:** templates for proforma, L/C, MTC and B/L; proforma created from the accepted offer; attached files read line by line and checked against the offer, the lot and earlier documents (matches / differs / not found); a mismatch on a required field needs a reason; `/demo` shows Ana and Bo side by side, each signed in on its own | `3628b13` | — | Yes |
| 2026-11-03 | RussCTGL | **Demo inputs and demo files:** English-only demo offer and simulated stock lists; a Demo input button on every form; generated documents attached to each order step that pass their template check; a demo stock list for intake | `82c3469` | — | Yes |
| 2026-11-04 | RussCTGL | **Guided story:** `/story` plays the whole flow in two side-by-side panes with captions, from the chat offer with a planted instruction to the corrected certificate; camera zoom on key results; `?fast=1` rehearses without model calls, `?record=1` records it; shorter nav | `eff8cd7`, `6aaaec4`, `4737aac` | — | Yes (the demo video is recorded from it) |

The phase commits group files by build phase in their final state; `docs/build-log.md` records the order of work, each phase's review gate and what it found.

## Not counted as hackathon work

- `create-next-app` boilerplate (first commit), and the Next-generated `AGENTS.md` and `next-env.d.ts`.
- Domain knowledge and the product idea, which predate the event.
