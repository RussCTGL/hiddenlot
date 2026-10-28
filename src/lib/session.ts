import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import type { Actor } from "@/auth/access";
import { getClockOffsetHours, getNetwork, getUser, listUsers, type NetworkRow, type UserRow } from "@/db/repo";
import { getDb } from "@/db/server";

// Demo sign-in: a cookie selects one of the synthetic users. There is no
// password because every user and network here is fictional; the server
// still re-checks the user on every request and every action.

export const ACTOR_COOKIE = "hl_actor";
const DEFAULT_USER = "u-ana";

export interface Session {
  actor: Actor;
  user: UserRow;
  network: NetworkRow;
}

export async function getSession(): Promise<Session | null> {
  // Everything behind a session is per-request data; never prerender it.
  await connection();
  const db = await getDb();
  const store = await cookies();
  const id = store.get(ACTOR_COOKIE)?.value ?? DEFAULT_USER;
  const user = (await getUser(db, id)) ?? (await getUser(db, DEFAULT_USER));
  if (!user) return null; // database not seeded yet
  const network = (await getNetwork(db, user.network_id))!;
  return { actor: { id: user.id, network_id: user.network_id, role: user.role }, user, network };
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) throw new Error("No demo data loaded. Run `npm run db:seed` or use Reset demo.");
  return s;
}

export async function listDemoUsers() {
  await connection();
  return listUsers(await getDb());
}

/**
 * Request time for rendering and actions (freshness, expiry, follow-ups). The
 * demo clock can be moved forward so time-based rules show without waiting;
 * pages here are request-time, never prerendered.
 */
export async function requestNow(): Promise<Date> {
  await connection();
  return new Date(Date.now() + (await getClockOffsetHours(await getDb())) * 3_600_000);
}
