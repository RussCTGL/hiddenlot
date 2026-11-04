# Demo video: recording notes and narration

The video is a recording of the guided story at `/story`, with a voice-over. The story plays by itself in 12 steps; the final cut is under three minutes.

## Recording

1. Run the app locally with the Meta key set (`npm run dev`), open `http://localhost:3000/story?fast=1` and play it once to warm up every page. Rehearsal mode uses the regex extractor, so it costs no model calls.
2. Open `http://localhost:3000/story?record=1`. Recording mode hides the controls, starts the story after six seconds on the intro card, and shows the live link and the repository on the closing card. Record at 1440×810 (or any 16:9 size); the model call in step 3 takes 20–35 s and is kept in, with its timer.
3. Cut: a 4.5 s cold open of the zoomed-in certificate mismatch (step 11), then the whole recording from the intro card to the closing card.

## Narration

Times are for the final cut (cold open + story, 2:53).
| Time | On screen | Say |
| Time | On screen | Say 
|---|---|---|
| 0:00.0 | COLD OPEN | This certificate is off by five hundredths of a millimetre. HiddenLot caught it before the coil shipped. Here's how. |
| 0:09.1 | Two traders | Ana buys steel in Vietnam. Bo sells surplus in Korea. They have never met. |
| 0:16.4 | Bo pastes | Bo pastes an offer straight from WhatsApp, messy like every real offer. But look at the last line. It's written to the AI: skip the checks, approve this deal. |
| 0:29.6 | Meta Muse Spark | Meta's Muse Spark model reads it, live. That timer is a real call, about twenty seconds. The model must quote the exact characters behind every value it extracts. Then plain code takes over. It checks that every quote is really in the text, converts units by fixed rules, and anything the seller never said stays Unknown. Eighteen values, every one quoted and checked. |
| 1:02.8 | The planted | And the planted line? Flagged, and ignored. A document is data. It can't approve anything. |
| 1:11.3 | Every value | Every value links to its source. Three millimetres, from line three. The standard's edition was never stated, so it stays Unknown. |
| 1:23.2 | Bo confirms | Bo confirms and publishes. Only the fields his network agreed to share ever leave it. |
| 1:31.1 | Ana’s map | Within a second, the lot lands on Ana's map, under Move forward. Nobody searched. Nobody sent a message. |
| 1:41.3 | Rules decide | Rules decide, not the model. Grade, size, quantity and timing, all checked by code. |
| 1:50.1 | Quote, offer | One click asks for a quote. Bo sees the question and the lot, but never Ana's budget. He answers with a firm offer: price, Incoterm, quantity, validity. It reaches Ana at once. She accepts, and the deal becomes a shared order. |
| 2:11.0 | Documents are | Bo builds the proforma from the accepted offer. HiddenLot reads it line by line, and checks it against the offer and the lot. All eleven required fields match. |
| 2:24.7 | A wrong certificate | On an earlier order, the certificate says 2.70 millimetres. The coil is 2.75. Both sides see it before it ships. |
| 2:35.8 | Bo sends | Bo attaches the corrected certificate. It is checked the moment it lands, and Ana's side turns green. |
| 2:45.9 | From a chat | HiddenLot. From a chat message to a checked order, without a single guessed value. |
