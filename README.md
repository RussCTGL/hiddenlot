# HiddenLot

Evidence-backed discovery of surplus steel supply across authorized trade networks.
Built for the Meta Global AI Developer Hackathon 2026 (10/26–11/04).

> **Status: Day 1 skeleton.** All data in this repo is synthetic and labeled as such.
> No real companies, prices, certificates or contacts.

## What exists today

| Piece | Where | Notes |
|---|---|---|
| Meta API adapter | `src/ai/meta/client.ts`, `src/ai/meta/server.ts` | Chat Completions with strict `json_schema` output; bounded retries; run records (model, latency, usage, status). App code imports `server.ts`, which is guarded by `server-only` so the key cannot reach the browser. Contributor-tier models are refused. |
| HRC schema v0.1 | `src/domain/hrc.ts` | `InventoryLot` with per-field observations (raw value, normalized value, status, evidence span), `Demand` with explicit bounds and substitution policy. `null` = Unknown. |
| Unit normalization | `src/domain/units.ts` | Deterministic; bare "ton" and missing units are never converted. |
| ExtractSupply task | `src/ai/tasks/extract-supply.ts` | Prompt v1 + model output schema + deterministic post-checks: evidence IDs exist, `raw` is verbatim in the cited fragment, numbers and units appear in `raw`. |
| Meta probe | `scripts/meta-probe.ts` | Runs one synthetic stock message through Meta and checks it against hand-written expected values. |

## Quick start

Requires Node 24.

```bash
npm install
cp .env.example .env.local   # then set META_API_KEY
npm test                     # offline unit tests, no key needed
npm run probe:meta -- --dry-run
npm run probe:meta           # live Meta call; writes evals/probe/runs/<timestamp>.json
npm run dev
```

Probe exit codes: `0` all checks pass, `1` some checks fail, `2` config error, `3` model call failed.

## How Meta is used

`muse-spark-1.3` (Standard mode) via `https://api.meta.ai/v1/chat/completions` reads untrusted seller text and returns field claims with verbatim quotes and fragment IDs. The model does not convert units, map grades between standards, or decide matches; deterministic code does, and anything it cannot verify stays Unknown for human review.

## Safety rules encoded so far

- `null` is Unknown, never 0 or "no limit".
- No grade equivalence table: Q235B, SS400 and S235JR are different grades.
- A unit the source never wrote is rejected (no assumed mm or metric tonnes).
- Instructions inside documents are reported as `ignored_instructions` and change nothing.
- Malformed model output is recorded as `invalid_output` and never becomes a passing result.

## Contributions

See [CONTRIBUTIONS.md](CONTRIBUTIONS.md).
