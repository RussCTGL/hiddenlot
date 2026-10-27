import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createStructuredCompletion, MetaConfigError, readMetaConfig, type MetaClientConfig } from "@/ai/meta/client";

const config: MetaClientConfig = {
  apiKey: "sk-test-secret",
  baseUrl: "https://api.meta.ai/v1",
  model: "muse-spark-1.3",
  timeoutMs: 1000,
  maxRetries: 2,
};
const schema = z.object({ answer: z.string().nullable() });
const request = { messages: [{ role: "user" as const, content: "hi" }], schemaName: "t", schema, promptVersion: "t.v1" };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const completion = (content: string) =>
  json(200, {
    model: "muse-spark-1.3",
    choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

function fakeFetch(responses: Response[]) {
  const calls: RequestInit[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return responses.shift()!;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("config requires a key and refuses contributor-tier models", () => {
  assert.throws(() => readMetaConfig({}), MetaConfigError);
  assert.throws(() => readMetaConfig({ META_API_KEY: "k", META_MODEL: "muse-spark-1.3-contributor" }), MetaConfigError);
  assert.equal(readMetaConfig({ META_API_KEY: "k" }).model, "muse-spark-1.3");
});

test("sends strict json_schema response_format and bearer auth", async () => {
  const { impl, calls } = fakeFetch([completion('{"answer":"ok"}')]);
  const { data, run } = await createStructuredCompletion(config, request, impl);
  assert.deepEqual(data, { answer: "ok" });
  assert.equal(run.result_status, "ok");
  assert.deepEqual(run.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  const body = JSON.parse(calls[0].body as string);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal((calls[0].headers as Record<string, string>).Authorization, "Bearer sk-test-secret");
});

test("invalid output is recorded, not retried, and yields no data", async () => {
  const { impl, calls } = fakeFetch([completion('{"answer": 42}')]);
  const { data, run } = await createStructuredCompletion(config, request, impl);
  assert.equal(data, null);
  assert.equal(run.result_status, "invalid_output");
  assert.equal(calls.length, 1);
});

test("429 is retried with bounded attempts", async () => {
  const { impl, calls } = fakeFetch([
    json(429, { error: "slow down" }, { "retry-after": "0.01" }),
    completion('{"answer":null}'),
  ]);
  const { data, run } = await createStructuredCompletion(config, request, impl);
  assert.deepEqual(data, { answer: null });
  assert.equal(run.attempts, 2);
  assert.equal(calls.length, 2);
});

test("error bodies never echo the API key", async () => {
  const { impl } = fakeFetch([json(401, { error: "bad key sk-test-secret" })]);
  const { run } = await createStructuredCompletion(config, request, impl);
  assert.equal(run.result_status, "http_error");
  assert.ok(!run.error?.includes("sk-test-secret"));
});

test("a timeout while reading the body is a recorded, retried failure, never an exception", async () => {
  const stalled = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const { impl, calls } = fakeFetch([stalled(), stalled(), stalled()]);
  const { data, run } = await createStructuredCompletion({ ...config, maxRetries: 2 }, request, impl);
  assert.equal(data, null);
  assert.equal(run.result_status, "timeout");
  assert.equal(calls.length, 3);
  const bad = fakeFetch([new Response("not json", { status: 200 })]);
  const r2 = await createStructuredCompletion(config, request, bad.impl);
  assert.equal(r2.run.result_status, "invalid_output");
});
