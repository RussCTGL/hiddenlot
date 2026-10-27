import "server-only";

import type { z } from "zod";
import {
  createStructuredCompletion,
  readMetaConfig,
  type MetaClientConfig,
  type StructuredRequest,
  type StructuredResult,
} from "@/ai/meta/client";

// Entry point for app code (route handlers, server actions, workers).
// The `server-only` import makes any client-component import a build error,
// so META_API_KEY can never be bundled for the browser.

let cached: MetaClientConfig | null = null;

export function getMetaConfig(): MetaClientConfig {
  cached ??= readMetaConfig(process.env);
  return cached;
}

export function metaStructured<T extends z.ZodType>(
  request: StructuredRequest<T>,
): Promise<StructuredResult<z.infer<T>>> {
  return createStructuredCompletion(getMetaConfig(), request);
}
