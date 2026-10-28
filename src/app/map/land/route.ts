import { landPath } from "@/geo/map";

// The detailed coastline for zoomed map views, as SVG path data. It is the
// same for every user and only changes with a release, so browsers keep it.

export function GET() {
  return new Response(landPath("fine"), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
}
