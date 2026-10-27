# Demo video script (≤ 3:00)

Recorded on the synthetic demo. Before recording: `npm run db:seed` (or **Reset demo**) so stock is fresh, and make sure `META_API_KEY` is set. Keep the yellow "Synthetic demo" banner visible in every shot.

| Time | Screen | Say (roughly) |
|---|---|---|
| 0:00–0:15 | Overview as **Network A** | "Steel traders lose deals because surplus coil sits in someone else's network, described in someone else's words. HiddenLot finds it — with evidence, and without pretending to know what it doesn't." |
| 0:15–0:40 | Switch to **Network B** → Intake. Paste the sample offer, Meta selected, tick synthetic, **Extract lots** | "Network B gets a stock offer as a chat message. Meta Muse Spark reads it. Every value it returns must quote the exact line it came from." |
| 0:40–1:05 | Document page: source on the left (cited lines highlighted), fields on the right with quotes and char spans; point at an Unknown | "Code checks every quote: it must really be on that line, the number and unit must be in it, units are converted in code. If the offer doesn't say it, it stays Unknown — never zero, never guessed." |
| 1:05–1:15 | **Confirm all** → **Publish to discovery**; show the "discovery checked…" message | "The owner reviews and publishes. Publishing runs discovery automatically against every demand Network B shares with." |
| 1:15–1:45 | Switch to **Network A** → Opportunities. Show the new candidate in "Worth human review" with the "From Network B · shared" badge; open it | "Network A's buyer needed 15–20 t of SS400 3.0 × 1500. Their own stock had nothing. Here it is from Network B — a declared spec match. Every hard requirement is listed; the MTC is a seller claim, not verified, and the heat link is not checked." |
| 1:45–2:05 | **Explain with Meta** → explanation with fact IDs | "Meta writes the explanation, but only from the rule results: every sentence cites a fact, and anything unsupported — new numbers, 'equivalent', 'certified' — is removed before you see it." |
| 2:05–2:30 | Back to the feed: **Engineering review required** (S235JR, Q235B, SS400 under KS D3503), **Not recommended** (plate, wrong standard, too late) | "Look-alikes are not recommended. Different grade or standard: engineering review, never an automatic match. Plate instead of coil, or too late: rejected, with the reason." |
| 2:30–2:50 | Shortlist the candidate with a reason → switch to **Network B** → Inventory → **Mark sold** → back to **A**: opportunity invalidated, details hidden | "Decisions are saved with the exact versions they were based on. When the seller sells the coil, the opportunity is invalidated at once — and if they revoke sharing, the details disappear." |
| 2:50–3:00 | Overview / README eval line | "Meta reads and explains; deterministic rules decide. Built during the hackathon, all on synthetic data." |

## Must not appear

- Any real company, person, price or certificate.
- Claims of certification, guaranteed quality, equivalence between grades, or deal probability.
- Unrecorded results: any number shown must come from `evals/results/` or the live screen.
