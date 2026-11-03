import type { Actor } from "@/auth/access";
import type { Db } from "@/db/client";
import { acceptOffer, acceptSuggestions, buildDigest, sendOffer } from "@/workflow/deals";
import { completeStep } from "@/workflow/orders";

// One order already under way for the demo: Network A (Ana) bought lot B-044
// from Network B (Bo). Bo confirmed and sent a proforma, Ana opened an L/C, and
// the mill test certificate is Bo's next step. Every step runs through the
// same workflow as a click in the app; the files are small generated PDFs,
// marked synthetic.

const ANA: Actor = { id: "u-ana", network_id: "net-a", role: "trader" };
const BO: Actor = { id: "u-bo", network_id: "net-b", role: "trader" };

export async function seedSampleOrder(db: Db, now: Date) {
  const at = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const s = (await buildDigest(db, ANA, at(6))).forward.find((x) => x.lotRef === "B-044");
  if (!s) throw new Error("seed: B-044 is not a forward candidate for Network A");
  await acceptSuggestions(db, ANA, [s.key], at(6));
  const deal = (await db.query<{ id: string }>(`SELECT id FROM deals WHERE buyer_network_id = 'net-a' AND lot_id = 'lot-b-044'`))[0].id;
  const validUntil = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  await sendOffer(db, BO, deal, { price: "498", currency: "USD", incoterm: "FOB Tianjin", valid_until: validUntil, quantity_t: 24 }, at(5));
  await acceptOffer(db, ANA, deal, at(4));
  await completeStep(db, BO, deal, "confirmed", "Reserved for Network A", null, at(3.5));
  await completeStep(
    db,
    BO,
    deal,
    "contract",
    "Proforma PI-B044-26",
    {
      filename: "Proforma PI-B044-26.pdf",
      bytes: tinyPdf("PROFORMA INVOICE PI-B044-26", [
        "Seller: Network B (fictional)    Buyer: Network A (fictional)",
        "Goods: HRC Q235B GB/T 700, 2.75 x 1250 mm, lot B-044",
        "Quantity: 24 t    Price: USD 498/MT FOB Tianjin",
        "Amount: USD 11,952.00    Payment: irrevocable L/C at sight",
        `Offer valid until ${validUntil}`,
      ]),
    },
    at(3),
  );
  await completeStep(
    db,
    ANA,
    deal,
    "payment",
    "L/C LC-A-26-0457 opened",
    {
      filename: "LC-A-26-0457.pdf",
      bytes: tinyPdf("LETTER OF CREDIT LC-A-26-0457 (COPY)", [
        "Applicant: Network A (fictional)    Beneficiary: Network B (fictional)",
        "Amount: USD 11,952.00, irrevocable, at sight",
        "Goods: 24 t HRC Q235B, lot B-044, FOB Tianjin",
        "Documents: commercial invoice, bill of lading, mill test certificate",
      ]),
    },
    at(2),
  );
  return deal;
}

/** A one-page PDF with a title and a few lines, stamped as a synthetic demo document. */
export function tinyPdf(title: string, lines: string[]): Uint8Array {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "?");
  const text = [
    `BT /F1 16 Tf 56 770 Td (${esc(title)}) Tj ET`,
    ...lines.map((l, i) => `BT /F1 11 Tf 56 ${730 - i * 20} Td (${esc(l)}) Tj ET`),
    `BT /F1 9 Tf 56 60 Td (SYNTHETIC DEMO DOCUMENT - fictional companies and figures, not a real trade.) Tj ET`,
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
