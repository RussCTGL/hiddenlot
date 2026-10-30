import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Sql } from "@/db/client";

// Sign-in accounts. Passwords are stored as scrypt hashes with a per-user
// salt; a session is a random token in an HTTP-only cookie, and the database
// keeps only its SHA-256, so a leaked table cannot be replayed as a cookie.

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEY_LEN = 32;
export const SESSION_DAYS = 7;

/** "scrypt$<salt>$<hash>", both base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [scheme, salt, hash] = (stored ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Compared against when the username is unknown, so timing does not reveal which usernames exist.
const NO_USER = `scrypt$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(KEY_LEN).toString("base64")}`;

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Checks a username and password; returns a new session token, or null. */
export async function signIn(sql: Sql, username: string, password: string, now: Date): Promise<string | null> {
  const rows = await sql.query<{ id: string; password_hash: string | null }>(`SELECT id, password_hash FROM users WHERE username = $1`, [username.trim().toLowerCase()]);
  const ok = await verifyPassword(password, rows[0]?.password_hash ?? NO_USER);
  if (!rows[0] || !ok) return null;
  return startSession(sql, rows[0].id, now);
}

export async function startSession(sql: Sql, userId: string, now: Date): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql.query(`INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`, [
    tokenHash(token),
    userId,
    now.toISOString(),
    new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString(),
  ]);
  return token;
}

/** The signed-in user's id, or null when the token is unknown or expired. */
export async function sessionUserId(sql: Sql, token: string | undefined, now: Date): Promise<string | null> {
  if (!token) return null;
  const rows = await sql.query<{ user_id: string }>(`SELECT user_id FROM user_sessions WHERE token_hash = $1 AND expires_at > $2`, [tokenHash(token), now.toISOString()]);
  return rows[0]?.user_id ?? null;
}

export async function endSession(sql: Sql, token: string | undefined): Promise<void> {
  if (token) await sql.query(`DELETE FROM user_sessions WHERE token_hash = $1`, [tokenHash(token)]);
}
