# Result files

Every run writes a timestamped JSON file here; nothing is deleted, including offline-only runs and superseded runs. Files contain extractor outputs on synthetic text, field-level outcomes, latency and token usage. None of them contains an API key or prompt text.

Files backing the numbers in `docs/evaluation.md`:

| Number | File |
|---|---|
| eval, prompt v3: B1 226/255 vs B3 230/255 | `extraction-eval-2026-10-27T06-51-34-183Z.json` |
| eval2, prompt v4: B1 225/258 vs B3 242/258 | `extraction-eval2-2026-10-27T07-01-43-679Z.json` |
| eval2 discovery (12 demands): recall, violations, A1 ablation | `discovery-eval2-2026-10-27T07-02-31-454Z.json` |
| eval2 discovery with the first demand set (1 positive pair; superseded) | `discovery-eval2-2026-10-27T07-01-50-921Z.json` |
| eval3, prompt v5: B1 235/263 vs B3 239/263 | `extraction-eval3-2026-10-27T07-08-24-149Z.json` |
| eval3 discovery | `discovery-eval3-2026-10-27T07-08-24-812Z.json` |
| Demo set, prompt v5: B1 79/81 vs B3 81/81; demo discovery | `extraction-demo-2026-10-27T07-10-43-498Z.json`, `discovery-demo-2026-10-27T07-10-44-187Z.json` |
| **eval4 (clean), prompt v6: B1 32/261 vs B3 261/261; claims on Unknowns caught 7/7 and 21/21** | `extraction-eval4-2026-10-27T07-31-06-996Z.json` (records prompt, model, dataset hash, git state) |
| eval4 discovery: recall 9/9, A1 48/60 | `discovery-eval4-2026-10-27T07-31-07-666Z.json` |
| eval4 first attempt (crashed on a client timeout bug, superseded) | `discovery-eval4-2026-10-27T07-25-21-297Z.json` |
| Demo set (development data) | `extraction-2026-10-27T06-18-24-672Z.json` (v2 prompt, 81/81), `extraction-2026-10-27T06-28-16-327Z.json` (v3, 75/81) |

Files without `--meta` in their run contain only the B1 baseline.
