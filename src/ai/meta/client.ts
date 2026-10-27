import { z } from "zod";
import { toStrictJsonSchema } from "@/ai/json-schema";

// Meta Model API adapter (OpenAI-compatible Chat Completions surface at
// https://api.meta.ai/v1). Plain fetch, no OpenAI SDK, so it is obvious that
// only Meta models are called.
//
// This module has no `server-only` guard so Node scripts (the probe, evals)
// can import it. App code must import `@/ai/meta/server` instead, which adds
// the guard and reads the key from the server environment.

export const META_PROVIDER = "meta";
export const DEFAULT_META_BASE_URL = "https://api.meta.ai/v1";
export const DEFAULT_META_MODEL = "muse-spark-1.3";

export interface MetaClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export class MetaConfigError extends Error {}

type Env = Record<string, string | undefined>;

export function readMetaConfig(env: Env): MetaClientConfig {
  const apiKey = env.META_API_KEY?.trim();
  if (!apiKey) throw new MetaConfigError("META_API_KEY is not set (see .env.example)");

  const model = env.META_MODEL?.trim() || DEFAULT_META_MODEL;
  // Contributor-tier models may use inputs for training and must not receive
  // confidential data. HiddenLot only runs Standard models (plan §10.5).
  if (model.endsWith("-contributor")) {
    throw new MetaConfigError(`Refusing contributor-tier model "${model}"; use a Standard model`);
  }

  const timeoutMs = Number(env.META_TIMEOUT_MS ?? 60_000);
  const maxRetries = Number(env.META_MAX_RETRIES ?? 2);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new MetaConfigError("META_TIMEOUT_MS must be > 0");
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) {
    throw new MetaConfigError("META_MAX_RETRIES must be 0, 1 or 2");
  }

  return {
    apiKey,
    baseUrl: (env.META_API_BASE_URL?.trim() || DEFAULT_META_BASE_URL).replace(/\/+$/, ""),
    model,
    timeoutMs,
    maxRetries,
  };
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type RunStatus =
  | "ok"
  | "invalid_output"
  | "refusal"
  | "rate_limited"
  | "timeout"
  | "http_error"
  | "network_error";

// Mirrors the `model_runs` table (plan §9.1). Prompts and outputs are not
// stored here by default; callers decide what is safe to persist.
export interface ModelRunRecord {
  provider: typeof META_PROVIDER;
  model_id: string;
  response_model_id: string | null;
  mode: "standard";
  prompt_version: string;
  schema_name: string;
  source_hash: string | null;
  started_at: string;
  latency_ms: number;
  attempts: number;
  http_status: number | null;
  finish_reason: string | null;
  usage: { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null } | null;
  result_status: RunStatus;
  error: string | null;
}

export interface StructuredRequest<T extends z.ZodType> {
  messages: ChatMessage[];
  schemaName: string;
  schema: T;
  promptVersion: string;
  sourceHash?: string;
  temperature?: number;
}

export interface StructuredResult<T> {
  data: T | null;
  run: ModelRunRecord;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createStructuredCompletion<T extends z.ZodType>(
  config: MetaClientConfig,
  request: StructuredRequest<T>,
  fetchImpl: typeof fetch = fetch,
): Promise<StructuredResult<z.infer<T>>> {
  const body = JSON.stringify({
    model: config.model,
    messages: request.messages,
    temperature: request.temperature ?? 0,
    response_format: {
      type: "json_schema",
      json_schema: { name: request.schemaName, strict: true, schema: toStrictJsonSchema(request.schema) },
    },
  });

  const startedAt = new Date();
  const t0 = performance.now();
  const run: ModelRunRecord = {
    provider: META_PROVIDER,
    model_id: config.model,
    response_model_id: null,
    mode: "standard",
    prompt_version: request.promptVersion,
    schema_name: request.schemaName,
    source_hash: request.sourceHash ?? null,
    started_at: startedAt.toISOString(),
    latency_ms: 0,
    attempts: 0,
    http_status: null,
    finish_reason: null,
    usage: null,
    result_status: "network_error",
    error: null,
  };
  const finish = (data: z.infer<T> | null): StructuredResult<z.infer<T>> => {
    run.latency_ms = Math.round(performance.now() - t0);
    return { data, run };
  };

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    run.attempts = attempt + 1;
    let res: Response;
    try {
      res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
      run.result_status = isTimeout ? "timeout" : "network_error";
      run.error = isTimeout ? `timed out after ${config.timeoutMs} ms` : String(err);
      if (attempt < config.maxRetries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return finish(null);
    }

    run.http_status = res.status;
    if (!res.ok) {
      run.result_status = res.status === 429 ? "rate_limited" : "http_error";
      run.error = redact(await res.text().catch(() => ""), config.apiKey).slice(0, 500);
      if (RETRYABLE_STATUS.has(res.status) && attempt < config.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after")) * 1000;
        await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1000 * 2 ** attempt, MAX_RETRY_AFTER_MS));
        continue;
      }
      return finish(null);
    }

    const payload = (await res.json()) as ChatCompletionResponse;
    run.response_model_id = payload.model ?? null;
    run.usage = payload.usage
      ? {
          prompt_tokens: payload.usage.prompt_tokens ?? null,
          completion_tokens: payload.usage.completion_tokens ?? null,
          total_tokens: payload.usage.total_tokens ?? null,
        }
      : null;

    const choice = payload.choices?.[0];
    run.finish_reason = choice?.finish_reason ?? null;
    if (choice?.message?.refusal || choice?.finish_reason === "content_filter") {
      run.result_status = "refusal";
      run.error = choice?.message?.refusal ?? "content_filter";
      return finish(null);
    }

    // Output-shape failures are not retried: a malformed answer is recorded
    // and never turned into a passing result.
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      run.result_status = "invalid_output";
      run.error = "no message content";
      return finish(null);
    }
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      run.result_status = "invalid_output";
      run.error = "content is not valid JSON";
      return finish(null);
    }
    const parsed = request.schema.safeParse(json);
    if (!parsed.success) {
      run.result_status = "invalid_output";
      run.error = z.prettifyError(parsed.error).slice(0, 1000);
      return finish(null);
    }
    run.result_status = "ok";
    run.error = null;
    return finish(parsed.data);
  }
  return finish(null);
}

interface ChatCompletionResponse {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[REDACTED]") : text;
}
