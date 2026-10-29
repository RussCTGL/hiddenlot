import { connection } from "next/server";
import { dailyReseed } from "@/lib/demo-maintenance";

// Daily reload of the shared public demo on a serverless host (vercel.json
// schedules it), so its stock confirmations never go stale. Anyone may call
// it; it reloads at most once per 20 hours.

export const maxDuration = 300;

export async function GET() {
  await connection(); // run per request, never at build time
  return Response.json({ reseeded: await dailyReseed() });
}
