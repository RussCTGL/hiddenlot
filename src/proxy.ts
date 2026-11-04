import { NextResponse, type NextRequest } from "next/server";
import { SEAT_HEADER, unseat } from "@/lib/seat";

// /seat2/… serves the same page as /… for the second signed-in account of the
// side-by-side demo (src/lib/seat.ts). The header only picks which of this
// browser's own session cookies is read, so it grants nothing by itself.

export function proxy(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = unseat(url.pathname);
  const headers = new Headers(request.headers);
  headers.set(SEAT_HEADER, "2");
  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = { matcher: ["/seat2", "/seat2/:path*"] };
