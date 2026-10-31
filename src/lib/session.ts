import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after, connection } from "next/server";
import { cache } from "react";
import type { Actor } from "@/auth/access";
import { sessionUserId, SESSION_DAYS } from "@/auth/accounts";
import { getClockOffsetHours, getNetwork, getUser, type NetworkRow, type UserRow } from "@/db/repo";
import { getDb } from "@/db/server";
import { catchUpMarket } from "./market-clock";

// Sign-in: an HTTP-only cookie holds a random session token (src/auth/accounts.ts).
// The server resolves it to a user on every request and every action; nothing
// the browser sends says who it is.

export const SESSION_COOKIE = "hl_session";

export const sessionCookie = (token: string) =>
  ({
    name: SESSION_COOKIE,
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
  const db = await getDb();
  const id = await sessionUserId(db, (await cookies()).get(SESSION_COOKIE)?.value, new Date());
  const user = id ? await getUser(db, id) : null;
  if (!user) return null;
  const network = (await getNetwork(db, user.network_id))!;
  // The simulated market moves on while people use the demo (after the response, never in its way).
  after(() => catchUpMarket().catch((err) => console.error("[hiddenlot] market tick failed", err)));
  return { actor: { id: user.id, network_id: user.network_id, role: user.role }, user, network };
});

/** The signed-in user; anyone else is sent to the sign-in page (or, before the demo is loaded, to its setup). */
export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
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
