import "server-only";
import { MetaConfigError } from "@/ai/meta/client";
import { getMetaConfig } from "@/ai/meta/server";
import { createStructuredCompletion } from "@/ai/meta/client";
import { EXPLAIN_PROMPT_VERSION, EXPLAIN_SCHEMA_NAME, Explanation } from "@/ai/tasks/explain-candidate";
import { metaExtractor } from "@/ai/tasks/run-extract-supply";
import { getDb } from "@/db/server";
import type { ExplainCall } from "@/workflow/explain";
import type { MetaExtract } from "@/ingestion/intake";
import { metaDailyLimit } from "./demo";

export class MetaQuotaError extends Error {}

/** Paid calls left today under HIDDENLOT_META_DAILY_LIMIT; null when there is no cap. */
export async function metaCallsLeft(): Promise<number | null> {
  const limit = metaDailyLimit();
  if (limit === null) return null;
  const rows = await (await getDb()).query<{ calls: number }>(`SELECT calls FROM meta_usage WHERE day = (now() AT TIME ZONE 'utc')::date`);
  return Math.max(0, limit - (rows[0]?.calls ?? 0));
}

/** Counts one paid call, refusing it once today's cap is used up. Atomic per call. */
async function takeMetaCall() {
  const limit = metaDailyLimit();
  const refused = new MetaQuotaError("Today's Meta limit for this demo is used up. Choose the regex baseline, or try again tomorrow.");
  if (limit === 0) throw refused; // the insert below would let the first call of a day through
  const db = await getDb();
  const rows = await db.query<{ calls: number }>(
    `INSERT INTO meta_usage (day, calls) VALUES ((now() AT TIME ZONE 'utc')::date, 1)
     ON CONFLICT (day) DO UPDATE SET calls = meta_usage.calls + 1
     WHERE $1::int IS NULL OR meta_usage.calls < $1::int
     RETURNING calls`,
    [limit],
  );
  if (rows.length === 0) throw refused;
}

/** The Meta extractor if a key is configured on the server, else null (UI offers the baseline). */
export function getMetaExtract(): MetaExtract | null {
  try {
    const extract = metaExtractor(getMetaConfig());
    return async (...args) => {
      await takeMetaCall();
      return extract(...args);
    };
  } catch (err) {
    if (err instanceof MetaConfigError) return null;
    throw err;
  }
}

export function metaAvailable(): boolean {
  return getMetaExtract() !== null;
}

export function getExplainCall(): ExplainCall | null {
  if (!metaAvailable()) return null;
  const config = getMetaConfig();
  return async (messages) => {
    await takeMetaCall();
    return createStructuredCompletion(config, { messages, schemaName: EXPLAIN_SCHEMA_NAME, schema: Explanation, promptVersion: EXPLAIN_PROMPT_VERSION });
  };
}
