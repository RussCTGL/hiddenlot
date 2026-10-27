/**
 * Day 1 Meta probe (plan §10.4).
 *
 * Sends one synthetic stock message through ExtractSupply against the live
 * Meta API, runs deterministic post-processing, and compares the result with
 * hand-written canonical truth. Writes a run record (no API key, no prompt)
 * to evals/probe/runs/.
 *
 *   npm run probe:meta               # live call; needs META_API_KEY in .env.local
 *   npm run probe:meta -- --dry-run  # no network; shows what would be sent
 *
 * Exit codes: 0 all checks pass · 1 some checks fail · 2 config error · 3 model call failed
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toStrictJsonSchema } from "@/ai/json-schema";
import { createStructuredCompletion, MetaConfigError, readMetaConfig } from "@/ai/meta/client";
import {
  buildExtractSupplyMessages,
  EXTRACT_SUPPLY_PROMPT_VERSION,
  EXTRACT_SUPPLY_SCHEMA_NAME,
  postProcessSupply,
  SupplyExtraction,
} from "@/ai/tasks/extract-supply";
import { HRC_SCHEMA_VERSION, type InventoryLot } from "@/domain/hrc";
import { fragmentText, sha256 } from "@/ingestion/text-fragments";

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fixtureArg = args[args.indexOf("--fixture") + 1];
const fixturePath = path.resolve(
  ROOT,
  args.includes("--fixture") && fixtureArg ? fixtureArg : "data/synthetic/probe/stock-network-b.txt",
);
const expectedPath = fixturePath.replace(/\.txt$/, ".expected.json");

type Expected = {
  owner_network_id: string;
  synthetic: boolean;
  lots: Record<string, Record<string, unknown>>;
  min_ignored_instructions: number;
};

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

async function main() {
  const envFile = path.join(ROOT, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const text = readFileSync(fixturePath, "utf8");
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as Expected;
  const sourceId = `synthetic:${path.basename(fixturePath)}`;
  const sourceHash = sha256(text);
  const fragments = fragmentText(text);
  const messages = buildExtractSupplyMessages(fragments, sourceId);
  const schemaBytes = JSON.stringify(toStrictJsonSchema(SupplyExtraction)).length;

  console.log(`fixture         ${path.relative(ROOT, fixturePath)} (${fragments.length} fragments, sha256 ${sourceHash.slice(0, 12)}…)`);
  console.log(`prompt          ${EXTRACT_SUPPLY_PROMPT_VERSION} · schema ${EXTRACT_SUPPLY_SCHEMA_NAME} (${schemaBytes} bytes, strict subset OK)`);
  console.log(`domain schema   HRC v${HRC_SCHEMA_VERSION}`);

  if (dryRun) {
    console.log("\n--dry-run: no network call. User message:\n");
    console.log(messages[1].content);
    return 0;
  }

  let config;
  try {
    config = readMetaConfig(process.env);
  } catch (err) {
    if (err instanceof MetaConfigError) {
      console.error(`\nconfig error: ${err.message}`);
      return 2;
    }
    throw err;
  }
  console.log(`model           ${config.model} @ ${config.baseUrl} (standard mode, timeout ${config.timeoutMs} ms, ≤${config.maxRetries} retries)\n`);

  const { data, run } = await createStructuredCompletion(config, {
    messages,
    schemaName: EXTRACT_SUPPLY_SCHEMA_NAME,
    schema: SupplyExtraction,
    promptVersion: EXTRACT_SUPPLY_PROMPT_VERSION,
    sourceHash,
  });

  console.log(
    `run             ${run.result_status} · http ${run.http_status ?? "-"} · ${run.latency_ms} ms · attempts ${run.attempts}` +
      ` · response model ${run.response_model_id ?? "?"} · finish ${run.finish_reason ?? "?"}`,
  );
  console.log(`usage           ${run.usage ? JSON.stringify(run.usage) : "not reported"}`);
  if (!data) {
    console.error(`\nmodel call failed: ${run.error}`);
    writeRun({ run, sourceHash, checks: [], output: null });
    return 3;
  }

  const runId = `probe-${run.started_at}`;
  const result = postProcessSupply(data, {
    fragments,
    sourceId,
    ownerNetworkId: expected.owner_network_id,
    synthetic: expected.synthetic,
    extractionRunId: runId,
    observedAt: run.started_at,
  });

  const checks = compare(result.lots, expected, result.ignored_instructions.length);
  checks.unshift(
    { name: "model call ok", pass: true, detail: `${run.model_id} · ${run.latency_ms} ms` },
    { name: "usage reported", pass: run.usage !== null, detail: run.usage ? `${run.usage.total_tokens} tokens` : "missing" },
  );

  console.log("\nchecks");
  for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(34)} ${c.detail}`);
  console.log(`\nissues (${result.issues.length})`);
  for (const i of result.issues) {
    console.log(`  lot ${i.lot_index ?? "-"} ${String(i.field ?? "-").padEnd(18)} ${i.code.padEnd(22)} ${i.detail}`);
  }
  console.log(`\nignored instructions (${result.ignored_instructions.length})`);
  for (const ins of result.ignored_instructions) console.log(`  [${ins.evidence.join(",")}] ${ins.note}`);

  const failed = checks.filter((c) => !c.pass).length;
  const file = writeRun({ run, sourceHash, checks, output: { model_output: data, ...result } });
  console.log(`\n${checks.length - failed}/${checks.length} checks passed · run saved to ${path.relative(ROOT, file)}`);
  return failed === 0 ? 0 : 1;
}

function compare(lots: InventoryLot[], expected: Expected, ignoredCount: number): Check[] {
  const checks: Check[] = [];
  const byRef = new Map(lots.map((l) => [l.fields.seller_lot_ref.normalized_value, l]));

  checks.push({
    name: "lot count",
    pass: lots.length === Object.keys(expected.lots).length,
    detail: `got ${lots.length}, expected ${Object.keys(expected.lots).length}`,
  });

  for (const [ref, fields] of Object.entries(expected.lots)) {
    const lot = byRef.get(ref);
    for (const [field, want] of Object.entries(fields)) {
      const name = `${ref}.${field}`;
      if (!lot) {
        checks.push({ name, pass: false, detail: "lot not extracted" });
        continue;
      }
      const obs = lot.fields[field as keyof InventoryLot["fields"]];
      const got = obs.normalized_value;
      checks.push({
        name,
        pass: matches(got, want),
        detail: `got ${JSON.stringify(got)} (${obs.status}${obs.issues.length ? `: ${obs.issues.join(", ")}` : ""})`,
      });
    }
  }

  const located = lots.flatMap((l) => Object.values(l.fields)).filter((o) => o.normalized_value !== null);
  const withSpan = located.filter((o) => o.evidence.length > 0 && o.evidence.every((e) => e.locator.kind === "text_span"));
  checks.push({
    name: "evidence span on every known field",
    pass: withSpan.length === located.length,
    detail: `${withSpan.length}/${located.length}`,
  });
  checks.push({
    name: "prompt injection reported",
    pass: ignoredCount >= expected.min_ignored_instructions,
    detail: `${ignoredCount} reported`,
  });
  return checks;
}

function matches(got: unknown, want: unknown): boolean {
  if (want === null) return got === null;
  if (typeof want === "object" && !Array.isArray(want) && "contains" in want) {
    return typeof got === "string" && got.includes(String((want as { contains: string }).contains));
  }
  if (Array.isArray(want)) {
    return Array.isArray(got) && JSON.stringify([...got].sort()) === JSON.stringify([...want].sort());
  }
  if (typeof want === "number") return typeof got === "number" && Math.abs(got - want) < 1e-6;
  return got === want;
}

function writeRun(record: { run: unknown; sourceHash: string; checks: Check[]; output: unknown }): string {
  const dir = path.join(ROOT, "evals/probe/runs");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        kind: "meta_probe",
        synthetic: true,
        fixture: path.relative(ROOT, fixturePath),
        source_hash: record.sourceHash,
        prompt_version: EXTRACT_SUPPLY_PROMPT_VERSION,
        hrc_schema_version: HRC_SCHEMA_VERSION,
        ...record,
      },
      null,
      2,
    ),
  );
  return file;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(3);
  },
);
