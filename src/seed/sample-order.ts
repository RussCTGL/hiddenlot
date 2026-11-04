import type { Actor } from "@/auth/access";
import type { Db } from "@/db/client";
import { acceptOffer, acceptSuggestions, buildDigest, sendOffer } from "@/workflow/deals";
import { tinyPdf } from "@/lib/tiny-pdf";
import { addDealFile, completeStep, createProforma } from "@/workflow/orders";

// One order already under way for the demo: Network A (Ana) bought lot B-044
// from Network B (Bo). Bo confirmed and sent a proforma, Ana opened an L/C, and
// the mill test certificate is Bo's next step. Every step runs through the
// same workflow as a click in the app; the files are small generated PDFs,
// marked synthetic. The proforma is built from the offer by the app and the
// L/C matches it; the MTC Bo attached shows 2.70 mm where the lot is 2.75 mm,
// so the demo opens on a document check that needs Bo's attention.

const ANA: Actor = { id: "u-ana", network_id: "net-a", role: "trader" };
const BO: Actor = { id: "u-bo", network_id: "net-b", role: "trader" };

export async function seedSampleOrder(db: Db, now: Date) {
  const at = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const s = (await buildDigest(db, ANA, at(6))).forward.find((x) => x.lotRef === "B-044");
  if (!s) throw new Error("seed: B-044 is not a forward candidate for Network A");
  await acceptSuggestions(db, ANA, [s.key], at(6));
  const deal = (await db.query<{ id: string }>(`SELECT id FROM deals WHERE buyer_network_id = 'net-a' AND lot_id = 'lot-b-044'`))[0].id;
  const day = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString().slice(0, 10);
  const validUntil = day(7);
  const lcExpiry = day(60);
  await sendOffer(db, BO, deal, { price: "498", currency: "USD", incoterm: "FOB Tianjin", valid_until: validUntil, quantity_t: 24 }, at(5));
  await acceptOffer(db, ANA, deal, at(4));
  await completeStep(db, BO, deal, "confirmed", "Reserved for Network A", null, at(3.5));
  await createProforma(db, BO, deal, "Irrevocable L/C at sight", at(3.2));
  await completeStep(db, BO, deal, "contract", "Proforma PI-B044-26", null, at(3));
  await completeStep(
    db,
    ANA,
    deal,
    "payment",
    "L/C LC-A-26-0457 opened",
    {
      filename: "LC-A-26-0457.pdf",
      bytes: tinyPdf("LETTER OF CREDIT (COPY)", [
        "L/C no.: LC-A-26-0457",
        "Applicant: Network A (fictional)",
        "Beneficiary: Network B (fictional)",
        "Amount: USD 11,952.00",
        "Form: irrevocable, payable at sight",
        "Goods: 24 t HRC Q235B GB/T 700, lot B-044, FOB Tianjin",
        "Documents required: commercial invoice, bill of lading, mill test certificate",
        `Expiry: ${lcExpiry}`,
      ]),
    },
    at(2),
  );
  await addDealFile(
    db,
    BO,
    deal,
    {
      filename: "MTC 26-1187.pdf",
      bytes: tinyPdf("MILL TEST CERTIFICATE (EN 10204 3.1)", [
        "Certificate no.: MTC-26-1187",
        "Grade / standard: Q235B GB/T 700-2006",
        "Heat numbers: 26-1187, 26-1188",
        "Dimensions: 2.70 x 1250 mm",
        "Weight: 24.06 t (3 coils)",
        "Chemical composition: C 0.16  Si 0.21  Mn 0.52  P 0.018  S 0.011",
        "Mechanical results: yield 275 MPa, tensile 420 MPa, elongation 31%",
      ]),
    },
    at(1),
    "mtc",
  );
  return deal;
}
