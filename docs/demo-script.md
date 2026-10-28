# Demo video script (≤ 3:00)

Recorded on the synthetic demo. Before recording: `npm run db:seed` (or **Reset demo**) so stock is fresh and the demo clock is back to real time, and make sure `META_API_KEY` is set. The seed confirms B-018's stock 30 h before the start, so it is the one lot that goes stale after **Skip ahead 1 day**. Keep the yellow "Synthetic demo" banner visible in every shot.

| Time | Screen | Say (roughly) |
|---|---|---|
| 0:00–0:15 | **Today** as **Network A**: "5 decisions today. About 2 minutes." | "Steel traders lose deals because surplus coil sits in someone else's network, described in someone else's words. HiddenLot does the sorting overnight and hands the buyer a short list of decisions." |
| 0:15–0:40 | Switch to **Network B** → Intake. Paste the sample offer, Meta selected, tick synthetic, **Extract lots** | "Network B gets a stock offer as a chat message. Meta Muse Spark reads it. Every value it returns must quote the exact line it came from." |
| 0:40–1:00 | Document page: cited lines highlighted, fields with quotes; point at an Unknown → **Confirm all** → **Publish** | "Code checks every quote. If the offer doesn't say it, it stays Unknown — never zero, never guessed. Publishing runs discovery for every network Network B shares with." |
| 1:00–1:30 | Back to **A** → Today. **Move forward**: B-018 with its checks, "MTC: seller's claim" and the drafted quote request. **Needs an answer**: C-104, drafted MTC question. Open the folded **engineering review** list | "Rules decide what can move forward. B-018 passes every hard requirement; the MTC is only the seller's claim, so the draft asks for a copy. C-104 is one answer away, and the question is already written. Other grades are parked for an engineer — never offered automatically." |
| 1:30–1:45 | Open B-018 → **Explain with Meta** | "Meta explains, but only from the rule results: every sentence cites a fact, and anything unsupported is removed." |
| 1:45–2:00 | Today → **Accept all** → **Deals** board | "One click: the quote requests and questions are now tracked deals. Nothing is sent — the buyer copies the drafts." |
| 2:00–2:25 | Footer → **Skip ahead 1 day** → Today: "Deal needs attention: stock not reconfirmed · 55 h" → open the deal | "The next morning HiddenLot is still watching. Network B confirmed this coil 55 hours ago, so before accepting a quote, ask them to reconfirm. The draft is ready." |
| 2:25–2:45 | Switch to **Network B** → Inventory → **Mark sold** on B-018 → back to **A** → Deals: B-018 under **Closed**, "Lot is sold" | "When the seller sells the coil, the deal closes by itself, and its lot details disappear." |
| 2:45–3:00 | Today | "Meta reads and explains; deterministic rules decide; the buyer just decides. Built during the hackathon, all on synthetic data." |

## Must not appear

- Any real company, person, price or certificate.
- Claims of certification, guaranteed quality, equivalence between grades, or deal probability.
- Unrecorded results: any number shown must come from `evals/results/` or the live screen.
