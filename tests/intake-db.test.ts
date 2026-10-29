import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { SupplyExtraction } from "@/ai/tasks/extract-supply";
import { getDocumentForActor, type Actor } from "@/auth/access";
import type { Db } from "@/db/client";
import { freshDb } from "./db";
import { intakeDocument, IntakeError, type MetaExtract } from "@/ingestion/intake";
import { NOW } from "./helpers";

let db: Db;
const B: Actor = { id: "u-b", network_id: "net-b", role: "trader" };
const enc = (s: string) => new TextEncoder().encode(s);
const probe = readFileSync(path.join(__dirname, "../data/synthetic/probe/stock-network-b.txt"));

before(async () => {
  db = await freshDb();
});
after(async () => db.close());
beforeEach(async () => {
  for (const t of ["audit_events", "opportunities", "match_assessments", "sharing_grants", "lot_versions", "lots", "extraction_runs", "source_fragments", "source_documents", "users", "networks"]) {
    await db.query(`DELETE FROM ${t}`);
  }
  await db.query(`INSERT INTO networks (id, name, alias) VALUES ('net-b','B','Network B')`);
  await db.query(`INSERT INTO users (id, network_id, name, role) VALUES ('u-b','net-b','b','trader')`);
});

const input = (bytes: Uint8Array, filename: string | null = "offer.txt", extractor: "meta" | "regex_baseline" = "regex_baseline") => ({
  bytes,
  filename,
  mime: null,
  extractor,
  synthetic: true,
});

test("text intake creates draft lots awaiting owner review, with fragments stored", async () => {
  const r = await intakeDocument(db, B, input(new Uint8Array(probe)), null, NOW);
  assert.equal(r.status, "needs_review");
  assert.equal(r.lots.length, 2);
  const statuses = await db.query<{ status: string }>(`SELECT status FROM lots`);
  assert.ok(statuses.every((s) => s.status === "needs_review"));
  const { fragments } = await getDocumentForActor(db, B, r.document_id);
  assert.ok(fragments.some((f) => f.text.includes("Lot B-018")));
});

test("the same file twice is one import", async () => {
  const first = await intakeDocument(db, B, input(new Uint8Array(probe)), null, NOW);
  const again = await intakeDocument(db, B, input(new Uint8Array(probe)), null, NOW);
  assert.equal(again.duplicate_document, true);
  assert.equal(again.document_id, first.document_id);
  assert.equal((await db.query(`SELECT 1 FROM lots`)).length, 2);
});

test("a re-forwarded copy of the same lot is not counted again (18 t never becomes 54 t)", async () => {
  await intakeDocument(db, B, input(new Uint8Array(probe)), null, NOW);
  const fwd1 = await intakeDocument(db, B, input(enc(`Fwd: see below\n\n${probe.toString()}`)), null, NOW);
  const fwd2 = await intakeDocument(db, B, input(enc(`FW: FW: stock\n${probe.toString()}\n-- sent from phone`)), null, NOW);
  // B-018 is fully specified, so its copies are recognised and dropped.
  assert.ok(fwd1.duplicates.some((d) => d.lot_index === 0));
  assert.ok(fwd2.duplicates.some((d) => d.lot_index === 0));
  const b018 = await db.query<{ n: string }>(`SELECT count(*) AS n FROM lots l JOIN lot_versions v ON v.lot_id = l.id WHERE v.data->'fields'->'seller_lot_ref'->>'normalized_value' = 'B-018'`);
  assert.equal(Number(b018[0].n), 1);
  // B-021 has unknown dimensions, so its copies cannot be proven identical: kept, but flagged for the owner.
  assert.ok(fwd1.issues.some((i) => i.code === "possible_duplicate"));
});

test("unsupported and broken files fail with a reason and create no lots", async () => {
  await assert.rejects(intakeDocument(db, B, input(enc("x"), "macro.xlsm"), null, NOW), IntakeError);
  await assert.rejects(intakeDocument(db, B, input(new Uint8Array(0)), null, NOW), /Empty file/);
  const broken = await intakeDocument(db, B, input(enc("not really a workbook"), "stock.xlsx"), null, NOW);
  assert.equal(broken.status, "failed");
  assert.match(broken.error!, /xlsx/);
  assert.equal((await db.query(`SELECT 1 FROM lots`)).length, 0);
});

test("Meta extraction failure is recorded and never yields lots", async () => {
  const failing: MetaExtract = async () => ({
    output: null,
    run: { result_status: "invalid_output" } as never,
    error: "Meta extraction invalid_output: schema mismatch",
  });
  const r = await intakeDocument(db, B, input(new Uint8Array(probe), "offer.txt", "meta"), failing, NOW);
  assert.equal(r.status, "failed");
  assert.equal(r.lots.length, 0);
  const runs = await db.query<{ status: string }>(`SELECT status FROM extraction_runs`);
  assert.equal(runs[0].status, "invalid_output");
});

test("Meta path: injected instructions are recorded as ignored and change nothing", async () => {
  const fake: MetaExtract = async () => {
    const out: SupplyExtraction = {
      lots: [],
      ambiguities: [],
      ignored_instructions: [{ note: "Asks the system to approve the deal", evidence: ["L22"] }],
    };
    return { output: out, run: { result_status: "ok" } as never, error: null };
  };
  const r = await intakeDocument(db, B, input(new Uint8Array(probe), "offer.txt", "meta"), fake, NOW);
  assert.equal(r.ignored_instructions.length, 1);
  assert.equal((await db.query(`SELECT 1 FROM lots WHERE status = 'published'`)).length, 0);
});

test("CSV intake produces lots with sheet-cell evidence", async () => {
  const csv = "SYNTHETIC — fictional stock\nLot,Grade,Standard,Product,Thickness (mm),Width (mm),Weight (MT),Condition\nC-101,SS400,KS D3503,HRC,3.0,1500,19.5,prime\n";
  const r = await intakeDocument(db, B, input(enc(csv), "stock.csv"), null, NOW);
  assert.equal(r.lots.length, 1);
  const [row] = await db.query<{ data: { fields: { thickness_mm: { evidence: { locator: unknown }[] } } } }>(`SELECT data FROM lot_versions`);
  assert.deepEqual(row.data.fields.thickness_mm.evidence[0].locator, { kind: "sheet_cell", sheet: "csv", row: 3, cell: "E3" });
});
