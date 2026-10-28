import assert from "node:assert/strict";
import { test } from "node:test";
import type { Actor } from "@/auth/access";
import { openDb } from "@/db/client";
import { discoverAll } from "@/discovery/engine";
import { checkScale, failureCount, oracle } from "@/seed/scale-check";
import { ALL_FIELDS, generateScale, loadScale, SCALE_PRESETS, worldHash } from "@/seed/scale";
import { createGrant, revokeGrant, setLotStatus } from "@/workflow/actions";
import { demand, lot, NOW } from "./helpers";

// Volume test at the smallest preset. The larger presets run
// with `npm run eval:scale`; this keeps the same oracle in the test suite.

const actorOf = (networkId: string): Actor => ({ id: `u-${networkId.slice(4)}`, network_id: networkId, role: "trader" });

test("the oracle agrees with the demo case and catches each planted deviation", () => {
  const none = new Set<never>();
  assert.equal(oracle(lot(), demand(), none, NOW).reviewable, true);
  assert.deepEqual(oracle(lot({ thickness_mm: 3.5 }), demand(), none, NOW).reasons, ["thickness_mm"]);
  assert.equal(oracle(lot({ grade_raw: "Q235B", standard_id: "GB/T 700" }), demand(), none, NOW).gradeMismatch, true);
  assert.deepEqual(oracle(lot(), demand(), new Set(["certificate_claims"] as const), NOW).reasons, ["certificate"]);
});

test("the generator is deterministic", () => {
  assert.equal(worldHash(generateScale(SCALE_PRESETS.test)), worldHash(generateScale(SCALE_PRESETS.test)));
});

test("discovery at volume: authorization, hard constraints, withheld fields and invalidation hold", async () => {
  const world = generateScale(SCALE_PRESETS.test);
  const now = new Date(world.now);
  const deadAtLoad = new Set(world.grants.filter((g) => g.revoked || !g.allow_discovery || (g.expires_at !== null && new Date(g.expires_at) <= now)).map((g) => g.id));
  const db = await openDb(null);
  try {
    await loadScale(db, world);
    const first = await discoverAll(db, now);
    assert.ok(first.reviewable > 0 && first.engineering_review > 0 && first.needs_evidence > 0, JSON.stringify(first));
    const second = await discoverAll(db, now);
    assert.equal(second.new_opportunities, 0);
    assert.equal(second.invalidated, 0);

    const before = await checkScale(db, world, now, { deadAtLoad, viewsPerNetwork: 2 });
    assert.equal(failureCount(before), 0, JSON.stringify(before.examples, null, 2));

    // Changes through the real actions, then the clock moves past some lots' freshness window.
    const later = new Date(now.getTime() + 30 * 3_600_000);
    const published = await db.query<{ id: string; owner_network_id: string; current_version: number }>(`SELECT id, owner_network_id, current_version FROM lots WHERE status = 'published' ORDER BY id`);
    for (const l of published.filter((_, i) => i % 15 === 0)) await setLotStatus(db, actorOf(l.owner_network_id), l.id, l.current_version, "sold", later);
    const live = await db.query<{ id: string; owner_network_id: string }>(`SELECT id, owner_network_id FROM sharing_grants WHERE revoked_at IS NULL ORDER BY id`);
    for (const g of live.filter((_, i) => i % 3 === 0)) await revokeGrant(db, actorOf(g.owner_network_id), g.id, later);
    const [owner, recipient] = [world.networks[0].id, world.networks[world.networks.length - 1].id];
    await createGrant(db, actorOf(owner), { recipient_network_id: recipient, lot_id: null, field_scope: ALL_FIELDS.filter((f) => f !== "thickness_mm"), allow_identity_disclosure: false, expires_at: null }, later);
    await discoverAll(db, later);

    const after = await checkScale(db, world, later, { deadAtLoad, viewsPerNetwork: 2 });
    assert.equal(failureCount(after), 0, JSON.stringify(after.examples, null, 2));
    const invalidated = await db.query(`SELECT 1 FROM opportunities WHERE status = 'invalidated'`);
    assert.ok(invalidated.length > 0, "the changes invalidated some opportunities");
  } finally {
    await db.close();
  }
});
