import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { after, connection } from "next/server";
import { cache } from "react";
import type { Actor } from "@/auth/access";
import { sessionUserId, SESSION_DAYS } from "@/auth/accounts";
import { getClockOffsetHours, getNetwork, getUser, type NetworkRow, type UserRow } from "@/db/repo";
import { getDb } from "@/db/server";
import { catchUpMarket } from "./market-clock";
import { atSeat, SEAT_HEADER, type Seat } from "./seat";

// Sign-in: an HTTP-only cookie holds a random session token (src/auth/accounts.ts).
// The server resolves it to a user on every request and every action; nothing
// the browser sends says who it is.

export const SESSION_COOKIE = "hl_session";

/** The second seat of the side-by-side demo keeps its own sign-in (src/lib/seat.ts). */
export const sessionCookieName = (seat: Seat) => (seat === 2 ? `${SESSION_COOKIE}_2` : SESSION_COOKIE);

/** Which seat this request is for: 2 under /seat2/…, else 1. */
export async function currentSeat(): Promise<Seat> {
  return (await headers()).get(SEAT_HEADER) === "2" ? 2 : 1;
}

/** An app path for links and redirects made on the server, kept in this request's seat. */
export async function seatPath(path: string): Promise<string> {
  return atSeat(await currentSeat(), path);
}

export const sessionCookie = (token: string, seat: Seat = 1) =>
  ({
    name: sessionCookieName(seat),
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  }) as const;

export interface Session {
  actor: Actor;
  user: UserRow;
  network: NetworkRow;
}

/** The signed-in user, or null. Memoised per request: the layout and the page both ask. */
export const getSession = cache(async (): Promise<Session | null> => {
  // Everything behind a session is per-request data; never prerender it.
  await connection();
  const s = await seatSession(await currentSeat());
  // The simulated market moves on while people use the demo (after the response, never in its way).
  if (s) after(() => catchUpMarket().catch((err) => console.error("[hiddenlot] market tick failed", err)));
  return s;
});

/** Who is signed in on a seat of this browser, whatever this request's own seat is (the /demo page shows both). */
export async function seatSession(seat: Seat): Promise<Session | null> {
  const db = await getDb();
  const id = await sessionUserId(db, (await cookies()).get(sessionCookieName(seat))?.value, new Date());
  const user = id ? await getUser(db, id) : null;
  if (!user) return null;
  const network = (await getNetwork(db, user.network_id))!;
  return { actor: { id: user.id, network_id: user.network_id, role: user.role }, user, network };
}

/** The signed-in user; anyone else is sent to the sign-in page (or, before the demo is loaded, to its setup). */
export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect(await seatPath("/login"));
  return s;
}

/** Whether the demo data (and so any account) exists yet. */
export async function demoLoaded(): Promise<boolean> {
  await connection();
  return (await (await getDb()).query(`SELECT 1 FROM users LIMIT 1`)).length > 0;
}

/**
 * Request time for rendering and actions (freshness, expiry, follow-ups). The
 * demo clock can be moved forward so time-based rules show without waiting;
 * pages here are request-time, never prerendered.
 */
export const requestNow = cache(async (): Promise<Date> => {
  await connection();
  return new Date(Date.now() + (await getClockOffsetHours(await getDb())) * 3_600_000);
});
