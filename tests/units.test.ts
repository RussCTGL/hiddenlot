import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeLengthToMm, normalizeMassToKg } from "@/domain/units";

test("metric tonnes convert to kg", () => {
  assert.deepEqual(normalizeMassToKg(18, "MT"), { ok: true, value: 18000, rule: "metric_tonne_to_kg" });
  assert.deepEqual(normalizeMassToKg(22, "吨"), { ok: true, value: 22000, rule: "cn_dun_metric_tonne_to_kg" });
});

test("bare 'ton' is ambiguous and never converted", () => {
  assert.deepEqual(normalizeMassToKg(22, "ton"), { ok: false, reason: "ambiguous_ton" });
  assert.deepEqual(normalizeMassToKg(22, "Tons"), { ok: false, reason: "ambiguous_ton" });
});

test("missing or unknown units stay unknown", () => {
  assert.deepEqual(normalizeLengthToMm(2.75, null), { ok: false, reason: "unit_missing" });
  assert.deepEqual(normalizeLengthToMm(3, "furlong"), { ok: false, reason: "unit_unrecognized" });
});

test("explicit inches convert to mm", () => {
  assert.deepEqual(normalizeLengthToMm(0.125, "inch"), { ok: true, value: 3.175, rule: "inch_to_mm" });
});

test("the port gazetteer matches English, Chinese and port-suffixed names", async () => {
  const { findPlace } = await import("@/geo/places");
  assert.equal(findPlace("Tianjin port 天津港")?.name, "Tianjin");
  assert.equal(findPlace("天津港")?.name, "Tianjin");
  assert.equal(findPlace("Kaohsiung port")?.name, "Kaohsiung");
  assert.equal(findPlace("Antwerp"), null);
  assert.equal(findPlace(null), null);
});
