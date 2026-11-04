import { demoInputs } from "@/lib/demo";
import { getSession, requestNow } from "@/lib/session";

// Demo only: a fresh synthetic stock list (CSV) for the signed-in network to
// try Intake with a file. Lot refs change every minute so a second try is not
// a duplicate of the first.

export async function GET() {
  if (!demoInputs()) return new Response("Not found", { status: 404 });
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  const now = await requestNow();
  const letter = session.network.alias.trim().slice(-1).toUpperCase().replace(/[^A-Z]/, "X");
  const n = 600 + (Math.floor(now.getTime() / 60_000) % 300) * 3;
  const day = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString().slice(0, 10);
  const rows = [
    [`${letter}-${n}`, "HRC", "SS400", "JIS G3101", "3.0", "1500", "18.2", "1", "prime", "MTC", "Busan", day(5), "USD 538/MT CFR Haiphong"],
    [`${letter}-${n + 1}`, "HRC", "Q235B", "GB/T 700", "2.75", "1250", "21.6", "2", "prime", "MTC", "Tianjin", day(12), "USD 505/MT FOB Tianjin"],
    [`${letter}-${n + 2}`, "HRC", "S235JR", "EN 10025-2", "3.0", "1500", "19", "1", "prime", "EN 10204 3.1", "Antwerp", day(20), ""],
  ];
  const csv = [
    `SYNTHETIC DEMO DATA — fictional stock list (${session.network.alias}); not real offers`,
    "Lot,Product,Grade,Standard,Thickness (mm),Width (mm),Weight (MT),Coils,Condition,Certificates,Location,Available from,Price",
    ...rows.map((r) => r.join(",")),
    "",
  ].join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="demo-stock-${letter}-${n}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
