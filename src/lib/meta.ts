import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { MetaConfigError } from "@/ai/meta/client";
import { getMetaConfig } from "@/ai/meta/server";
import { createStructuredCompletion } from "@/ai/meta/client";
import { EXPLAIN_PROMPT_VERSION, EXPLAIN_SCHEMA_NAME, Explanation } from "@/ai/tasks/explain-candidate";
import { metaExtractor } from "@/ai/tasks/run-extract-supply";
import { getDb } from "@/db/server";
import type { ExplainCall } from "@/workflow/explain";
import type { MetaExtract } from "@/ingestion/intake";
import { metaDailyLimit, metaVisitorLimit } from "./demo";

export class MetaQuotaError extends Error {}

const TODAY = `(now() AT TIME ZONE 'utc')::date`;

/** Paid calls left today for this visitor, under both caps; null when there is no cap. */
export async function metaCallsLeft(): Promise<number | null> {
  const db = await getDb();
  const left: number[] = [];
  const limit = metaDailyLimit();
  if (limit !== null) {
    const rows = await db.query<{ calls: number }>(`SELECT calls FROM meta_usage WHERE day = ${TODAY}`);
    left.push(limit - (rows[0]?.calls ?? 0));
  }
  const perVisitor = metaVisitorLimit();
  const visitor = perVisitor === null ? null : await visitorKey();
  if (perVisitor !== null && visitor !== null) {
    const rows = await db.query<{ calls: number }>(`SELECT calls FROM meta_usage_by_visitor WHERE day = ${TODAY} AND visitor = $1`, [visitor]);
    left.push(perVisitor - (rows[0]?.calls ?? 0));
  }
  return left.length ? Math.max(0, Math.min(...left)) : null;
}

/**
 * The visitor behind this request, as a hash of the client address and the
 * day (addresses are never stored); null outside a request or without one.
 * Hosts such as Vercel set x-forwarded-for to the real client address.
 */
async function visitorKey(): Promise<string | null> {
  try {
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip");
    if (!ip) return null;
    return createHash("sha256").update(`${new Date().toISOString().slice(0, 10)}|${ip}`).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

/** Counts one paid call against the visitor's and the daily cap, refusing it once either is used up. Atomic per call. */
async function takeMetaCall() {
  const limit = metaDailyLimit();
  const perVisitor = metaVisitorLimit();
  const refused = new MetaQuotaError("Today's Meta limit for this demo is used up. Choose the regex baseline, or try again tomorrow.");
  if (limit === 0 || perVisitor === 0) throw refused; // the inserts below would let the first call of a day through
  const visitor = perVisitor === null ? null : await visitorKey();
  await (await getDb()).transaction(async (tx) => {
    if (visitor !== null) {
      const mine = await tx.query(
        `INSERT INTO meta_usage_by_visitor (day, visitor, calls) VALUES (${TODAY}, $1, 1)
         ON CONFLICT (day, visitor) DO UPDATE SET calls = meta_usage_by_visitor.calls + 1
         WHERE meta_usage_by_visitor.calls < $2::int
         RETURNING calls`,
        [visitor, perVisitor],
      );
      if (mine.length === 0) throw refused;
    }
    const rows = await tx.query(
      `INSERT INTO meta_usage (day, calls) VALUES (${TODAY}, 1)
       ON CONFLICT (day) DO UPDATE SET calls = meta_usage.calls + 1
       WHERE $1::int IS NULL OR meta_usage.calls < $1::int
       RETURNING calls`,
      [limit],
    );
    if (rows.length === 0) throw refused; // rolls back the visitor's count too
  });
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
