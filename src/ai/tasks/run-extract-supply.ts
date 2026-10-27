import { createStructuredCompletion, type MetaClientConfig } from "@/ai/meta/client";
import type { MetaExtract } from "@/ingestion/intake";
import {
  buildExtractSupplyMessages,
  EXTRACT_SUPPLY_PROMPT_VERSION,
  EXTRACT_SUPPLY_SCHEMA_NAME,
  SupplyExtraction,
} from "./extract-supply";

/** Binds ExtractSupply to a Meta config. Failed or malformed runs return no output, never a partial pass. */
export function metaExtractor(config: MetaClientConfig, fetchImpl: typeof fetch = fetch): MetaExtract {
  return async (fragments, sourceId, sourceHash) => {
    const { data, run } = await createStructuredCompletion(
      config,
      {
        messages: buildExtractSupplyMessages(fragments, sourceId),
        schemaName: EXTRACT_SUPPLY_SCHEMA_NAME,
        schema: SupplyExtraction,
        promptVersion: EXTRACT_SUPPLY_PROMPT_VERSION,
        sourceHash,
      },
      fetchImpl,
    );
    return { output: data, run, error: data ? null : `Meta extraction ${run.result_status}: ${run.error ?? "no output"}` };
  };
}
