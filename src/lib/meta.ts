import "server-only";
import { MetaConfigError } from "@/ai/meta/client";
import { getMetaConfig } from "@/ai/meta/server";
import { createStructuredCompletion } from "@/ai/meta/client";
import { EXPLAIN_PROMPT_VERSION, EXPLAIN_SCHEMA_NAME, Explanation } from "@/ai/tasks/explain-candidate";
import { metaExtractor } from "@/ai/tasks/run-extract-supply";
import type { ExplainCall } from "@/workflow/explain";
import type { MetaExtract } from "@/ingestion/intake";

/** The Meta extractor if a key is configured on the server, else null (UI offers the baseline). */
export function getMetaExtract(): MetaExtract | null {
  try {
    return metaExtractor(getMetaConfig());
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
  return (messages) => createStructuredCompletion(config, { messages, schemaName: EXPLAIN_SCHEMA_NAME, schema: Explanation, promptVersion: EXPLAIN_PROMPT_VERSION });
}
