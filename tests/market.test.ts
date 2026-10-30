import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Actor } from "@/auth/access";
import { endSession, hashPassword, sessionUserId, signIn, verifyPassword } from "@/auth/accounts";
import type { Db } from "@/db/client";
import { getLot } from "@/db/repo";
import { seedDemo } from "@/seed/demo";
import { listMarketEvents, loadMarket, runMarketTick } from "@/sim/market";
import { acceptSuggestions, allSuggestions, buildDigest, listDealsForActor } from "@/workflow/deals";
import { freshDb } from "./db";

// Sign-in accounts and the simulated market: pseudo users post stock and
// demands through the real pipeline, answer buyers' questions by correcting
// their own lots, and the Activity feed shows each network only what it may see.

let db: Db;
const NOW = new Date("2026-10-27T12:00:00.000Z");
const hour = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
const DANA: Actor = { id: "u-dana", network_id: "net-d", role: "trader" };
const PASSWORD = loadMarket().demo_password;

before(async () => {
  db = await freshDb();
  await seedDemo(db, NOW);
});
after(async () => db.close());

test("passwords are salted scrypt hashes and verify only with the right password", async () => {
  const a = await hashPassword("correct horse");
  const b = await hashPassword("correct horse");
  assert.notEqual(a, b);
  assert.ok(await verifyPassword("correct horse", a));
  assert.ok(!(await verifyPassword("wrong", a)));
  assert.ok(!(await verifyPassword("correct horse", null)));
});

test("demo accounts sign in with the demo password; sessions are stored hashed and can end", async () => {
  assert.equal(await signIn(db, "dana", "nope", NOW), null);
  assert.equal(await signIn(db, "nobody", PASSWORD, NOW), null);
  const token = await signIn(db, " Dana ", PASSWORD, NOW);
  assert.ok(token);
  assert.equal(await sessionUserId(db, token, NOW), "u-dana");
  const stored = await db.query<{ token_hash: string }>(`SELECT token_hash FROM user_sessions`);
  assert.ok(stored.every((r) => r.token_hash !== token));
  assert.equal(await sessionUserId(db, token, hour(24 * 8)), null, "expires after 7 days");
  await endSession(db, token);
  assert.equal(await sessionUserId(db, token, NOW), null);
});

test("pseudo users have accounts too, and the demo story is unchanged by them", async () => {
  const users = await db.query<{ username: string; simulated: boolean }>(`SELECT username, simulated FROM users ORDER BY username`);
  assert.deepEqual(
    users.filter((u) => u.simulated).map((u) => u.username),
    ["jun", "linh", "mei", "omar", "ray", "sofia"],
  );
  assert.ok(users.every((u) => u.username));
  assert.equal((await db.query(`SELECT 1 FROM market_events`)).length, 0);
});

test("a buyer's question gets answered: E-305's 'tons' become metric tonnes and the deal sees the change", async () => {
  const d = await buildDigest(db, DANA, NOW);
  await acceptSuggestions(db, DANA, allSuggestions(d).map((s) => s.key), NOW);
  const before = (await getLot(db, "lot-e-305"))!;
  assert.equal(before.data.fields.total_kg.normalized_value, null);

  let answered = false;
  for (let i = 1; i <= 12 && !answered; i++) {
    const r = await runMarketTick(db, hour(i));
    answered = r.events.some((e) => e.kind === "answer" && e.summary.includes("E-305"));
  }
  assert.ok(answered, "Sofia answers within a few ticks");
  const lot = (await getLot(db, "lot-e-305"))!;
  assert.equal(lot.data.fields.total_kg.normalized_value, 20_000);
  assert.equal(lot.data.fields.total_kg.review?.status, "corrected");
  const deal = (await listDealsForActor(db, DANA, hour(12))).find((x) => x.deal.lot_id === "lot-e-305");
  assert.ok(deal, "Dana's deal on E-305 is still tracked");
});

test("many ticks run through the real pipeline and stay bounded", async () => {
  const kinds = new Map<string, number>();
  for (let i = 13; i <= 60; i++) {
    for (const e of (await runMarketTick(db, hour(i))).events) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  }
  assert.ok((kinds.get("stock") ?? 0) >= 10, `stock posts: ${kinds.get("stock")}`);
  assert.ok((kinds.get("demand") ?? 0) >= 5, `demands: ${kinds.get("demand")}`);
  const live = await db.query<{ owner_network_id: string; n: string }>(
    `SELECT owner_network_id, count(*) AS n FROM lots WHERE id LIKE 'lot-sim-%' AND status = 'published' GROUP BY owner_network_id`,
  );
  assert.ok(live.every((r) => Number(r.n) <= 10), JSON.stringify(live));
  const demands = await db.query<{ n: string }>(`SELECT count(*) AS n FROM demands WHERE id LIKE 'dem-sim-%' AND status = 'active' GROUP BY buyer_network_id`);
  assert.ok(demands.every((r) => Number(r.n) <= 4));
  // Every simulated document passed the evidence checks: no extraction issues on any simulated lot.
  const runs = await db.query<{ status: string }>(`SELECT status FROM extraction_runs WHERE extractor = 'market_sim'`);
  assert.ok(runs.length >= 10 && runs.every((r) => r.status === "ok"), JSON.stringify([...new Set(runs.map((r) => r.status))]));
  // The pseudo buyers find stock across networks.
  const opps = await db.query<{ n: string }>(`SELECT count(*) AS n FROM opportunities WHERE demand_id LIKE 'dem-sim-%' AND status <> 'invalidated'`);
  assert.ok(Number(opps[0].n) > 0);
});

test("the activity feed shows a network its own events in full and partners' in summary, nothing else", async () => {
  const a = await listMarketEvents(db, "net-a", hour(60), 500);
  const f = await listMarketEvents(db, "net-f", hour(60), 500);
  const all = await db.query<{ network_id: string; shared_summary: string | null }>(`SELECT network_id, shared_summary FROM market_events`);
  // Network A receives from B and C only; it never sees D's or E's activity, or anyone's demands.
  assert.ok(a.filter((e) => !e.own).every((e) => ["Network B", "Network C"].includes(e.network_alias)));
  assert.ok(a.filter((e) => !e.own).every((e) => e.kind !== "demand"));
  assert.ok(a.some((e) => e.own) && a.some((e) => !e.own));
  // Shared lines are the short summaries, never the owner's detail.
  assert.ok(f.filter((e) => !e.own).every((e) => /^Network [BCE] (listed|sold|answered)/.test(e.summary)));
  assert.ok(all.some((e) => e.network_id === "net-e"));
});

test("the same state and tick number give the same activity", async () => {
  const run = async () => {
    const x = await freshDb();
    await seedDemo(x, NOW);
    const out: string[] = [];
    for (let i = 1; i <= 8; i++) out.push(...(await runMarketTick(x, hour(i))).events.map((e) => e.summary));
    await x.close();
    return out;
  };
  assert.deepEqual(await run(), await run());
});
