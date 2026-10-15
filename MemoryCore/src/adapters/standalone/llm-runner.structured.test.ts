/**
 * StandaloneLLMRunner structured-output tests (issue #1210).
 *
 * Covers the three-tier capability fallback:
 *   tier 1  json_schema (provider-native constrained generation)
 *   tier 2  json_object (+ local validation by the caller)
 *   tier 3  plain text (existing path)
 *
 * Degradation ONLY on explicit structured-output capability errors
 * (APICallError 400/422 + response_format/json_schema/json_object evidence).
 * Everything else (auth errors, 429/5xx, generic 400s) must propagate.
 * NoObjectGeneratedError (model responded, output unusable) must resolve with
 * the SAME response text — never a second LLM call.
 *
 * The upstream is simulated by stubbing globalThis.fetch with OpenAI
 * chat-completions shaped responses (non-stream and SSE stream).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonSchema, tool } from "ai";
import { StandaloneLLMRunner } from "./llm-runner.js";
import { report } from "../../core/report/reporter.js";

vi.mock("../../core/report/reporter.js", () => ({ report: vi.fn() }));

const reportMock = vi.mocked(report);

const CFG = {
  baseUrl: "http://stubbed.invalid/v1",
  apiKey: "test-key",
  model: "test-model",
};

const STRUCTURED_SCHEMA = {
  type: "object",
  properties: {
    scenes: {
      type: "array",
      items: {
        type: "object",
        properties: { scene_name: { type: "string" } },
        required: ["scene_name"],
        additionalProperties: false,
      },
    },
  },
  required: ["scenes"],
  additionalProperties: false,
};

function structuredParams() {
  return {
    prompt: "extract memories",
    systemPrompt: "system",
    taskId: "l1-extraction",
    structuredOutput: {
      schema: STRUCTURED_SCHEMA,
      schemaName: "l1_scene_extraction",
      validate: (value: unknown) =>
        !!value && typeof value === "object" && Array.isArray((value as { scenes?: unknown }).scenes),
    },
  };
}

// ============================
// fetch stub helpers
// ============================

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

let calls: CapturedRequest[];
let responses: Array<() => Response>;
let lastResponse: (() => Response) | undefined;

function chatCompletion(content: string, usage?: Record<string, number>): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        ...(usage ? { usage } : {}),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

function apiError(status: number, message: string): () => Response {
  return () =>
    new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
      status,
      headers: { "content-type": "application/json" } },
    );
}

/** SSE chat.completion.chunk stream that concatenates `chunks` into content. */
function sseCompletion(chunks: string[]): () => Response {
  const events = chunks
    .map(
      (content) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-2",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        })}\n\n`,
    )
    .join("");
  const final =
    `data: ${JSON.stringify({
      id: "chatcmpl-2",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    })}\n\n` + "data: [DONE]\n\n";
  return () => new Response(events + final, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  calls = [];
  responses = [];
  lastResponse = undefined;
  reportMock.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} });
      // Queue drains front-first; when empty, repeat the last response so
      // AI SDK internal retries (maxRetries=2 by default) see the same error.
      const next = responses.shift() ?? lastResponse;
      if (!next) throw new Error("no stubbed response");
      lastResponse = next;
      return next();
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRunner(opts?: { stream?: boolean; enableTools?: boolean }) {
  return new StandaloneLLMRunner({
    config: CFG,
    ...(opts?.stream !== undefined ? { stream: opts.stream } : {}),
    ...(opts?.enableTools !== undefined ? { enableTools: opts.enableTools } : {}),
  });
}

function spyLogger() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return logger;
}

function failureReports() {
  return reportMock.mock.calls.filter(([, payload]) => (payload as { success?: boolean }).success === false);
}

// ============================
// Structured output tiers
// ============================

describe("StandaloneLLMRunner structured output", () => {
  it("tier 1: sends response_format=json_schema (strict by default) and returns the text", async () => {
    responses.push(chatCompletion('{"scenes":[{"scene_name":"行程"}]}', { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }));
    const runner = makeRunner();
    const text = await runner.run(structuredParams());

    expect(text).toBe('{"scenes":[{"scene_name":"行程"}]}');
    expect(calls).toHaveLength(1);
    const responseFormat = calls[0]!.body.response_format as Record<string, unknown>;
    expect(responseFormat.type).toBe("json_schema");
    const jsonSchemaField = responseFormat.json_schema as Record<string, unknown>;
    expect(jsonSchemaField.strict).toBe(true); // keep provider default (strict)
    expect(jsonSchemaField.name).toBe("l1_scene_extraction");
    expect((jsonSchemaField.schema as Record<string, unknown>).type).toBe("object");
    expect(runner.lastUsage).toEqual({ promptTokens: 5, completionTokens: 7, totalTokens: 12 });
  });

  it("tier 1 → tier 2: explicit response_format rejection degrades to json_object (usage from winning call)", async () => {
    responses.push(apiError(400, "response_format of type json_schema is not supported by this model"));
    responses.push(chatCompletion('{"scenes":[]}', { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }));
    const runner = makeRunner();
    const text = await runner.run(structuredParams());

    expect(text).toBe('{"scenes":[]}');
    expect(calls).toHaveLength(2);
    expect((calls[0]!.body.response_format as Record<string, unknown>).type).toBe("json_schema");
    expect((calls[1]!.body.response_format as Record<string, unknown>).type).toBe("json_object");
    expect(runner.lastUsage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  });

  it("tier 2 → tier 3: json_object also rejected falls back to plain text (no response_format)", async () => {
    responses.push(apiError(400, "response_format is not supported"));
    responses.push(apiError(422, "json_object mode is not supported on this endpoint"));
    responses.push(chatCompletion('{"scenes":[]}'));
    const text = await makeRunner().run(structuredParams());

    expect(text).toBe('{"scenes":[]}');
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body.response_format).toBeUndefined();
    expect(calls[2]!.body.model).toBe("test-model");
  });

  it("generic 400 (invalid api key) must NOT fall back — it rejects after exactly one request", async () => {
    responses.push(apiError(400, "Incorrect API key provided"));
    await expect(makeRunner().run(structuredParams())).rejects.toThrow(/API key/i);
    expect(calls).toHaveLength(1);
  });

  it("model-not-found 400 must NOT fall back", async () => {
    responses.push(apiError(400, "The model `nope` does not exist"));
    await expect(makeRunner().run(structuredParams())).rejects.toThrow(/does not exist/i);
    expect(calls).toHaveLength(1);
  });

  it("F5 matrix: 'Invalid schema for response_format' (our schema bug) must THROW, not fall back", async () => {
    responses.push(apiError(400, "Invalid schema for response_format: 'propertyNames' is not permitted"));
    await expect(makeRunner().run(structuredParams())).rejects.toThrow(/Invalid schema/i);
    expect(calls).toHaveLength(1);
  });

  it("F5 matrix: 'invalid json_schema: missing required property' must THROW", async () => {
    responses.push(apiError(422, "invalid json_schema: 'merged_content' is a required property"));
    await expect(makeRunner().run(structuredParams())).rejects.toThrow(/json_schema/i);
    expect(calls).toHaveLength(1);
  });

  it("F5 matrix: 'unsupported schema keyword' is a schema-authoring error — must THROW even though it says 'unsupported'", async () => {
    responses.push(apiError(400, "Invalid schema for response_format: unsupported schema keyword propertyNames"));
    await expect(makeRunner().run(structuredParams())).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("F5 matrix: 'the keyword patternProperties is not supported' inside an invalid-schema error must THROW", async () => {
    responses.push(apiError(422, "Invalid json_schema: the keyword patternProperties is not supported"));
    await expect(makeRunner().run(structuredParams())).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("N2: plain-path failure is logged and reported EXACTLY once", async () => {
    responses.push(apiError(400, "This model's maximum context length is 8192 tokens, however you requested 20000"));
    const logger = spyLogger();
    const runner = new StandaloneLLMRunner({ config: CFG, logger });

    await expect(runner.run({ prompt: "p", taskId: "t", instanceId: "i1" })).rejects.toThrow(/context length/i);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(failureReports()).toHaveLength(1);
    const payload = failureReports()[0]![1] as Record<string, unknown>;
    expect(payload.success).toBe(false);
    expect(payload.taskId).toBe("t");
  });

  it("N2: tier-3 failure is logged and reported EXACTLY once (no double counting across tiers)", async () => {
    responses.push(apiError(400, "response_format is not supported"));
    responses.push(apiError(422, "json_object mode is not supported"));
    responses.push(apiError(400, "This model's maximum context length is 8192 tokens"));
    const logger = spyLogger();
    const runner = new StandaloneLLMRunner({ config: CFG, logger });

    await expect(runner.run({ ...structuredParams(), instanceId: "i1" })).rejects.toThrow();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(failureReports()).toHaveLength(1);
  });

  it("N2: structured success still reports once", async () => {
    responses.push(chatCompletion('{"scenes":[]}'));
    const runner = makeRunner();
    await runner.run({ ...structuredParams(), instanceId: "i1" });
    expect(reportMock).toHaveBeenCalledTimes(1);
    expect((reportMock.mock.calls[0]![1] as Record<string, unknown>).success).toBe(true);
  });

  it("F5 matrix: context-length 400 must THROW", async () => {
    responses.push(apiError(400, "This model's maximum context length is 8192 tokens, however you requested 20000"));
    await expect(makeRunner().run(structuredParams())).rejects.toThrow(/context length/i);
    expect(calls).toHaveLength(1);
  });

  it("F5 matrix: 'unknown parameter: response_format' degrades to json_object", async () => {
    responses.push(apiError(400, "Unknown parameter: 'response_format'"));
    responses.push(chatCompletion('{"scenes":[]}'));
    const text = await makeRunner().run(structuredParams());
    expect(text).toBe('{"scenes":[]}');
    expect(calls).toHaveLength(2);
    expect((calls[1]!.body.response_format as Record<string, unknown>).type).toBe("json_object");
  });

  it("F5 matrix: 'model does not support json_schema' degrades to json_object", async () => {
    responses.push(apiError(400, "Model gpt-3.5 does not support json_schema response format"));
    responses.push(chatCompletion('{"scenes":[]}'));
    const text = await makeRunner().run(structuredParams());
    expect(text).toBe('{"scenes":[]}');
    expect(calls).toHaveLength(2);
    expect((calls[1]!.body.response_format as Record<string, unknown>).type).toBe("json_object");
  });

  it("F5 matrix: 'Unrecognized request argument supplied: response_format' degrades", async () => {
    responses.push(apiError(400, "Unrecognized request argument supplied: response_format"));
    responses.push(chatCompletion('{"scenes":[]}'));
    const text = await makeRunner().run(structuredParams());
    expect(text).toBe('{"scenes":[]}');
    expect(calls).toHaveLength(2);
    expect((calls[1]!.body.response_format as Record<string, unknown>).type).toBe("json_object");
  });

  it("429 must NOT fall back to json_object — every attempt stays json_schema and finally rejects", async () => {
    responses.push(apiError(429, "rate limit exceeded"));
    await expect(makeRunner().run(structuredParams())).rejects.toThrow();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      expect((call.body.response_format as Record<string, unknown> | undefined)?.type).toBe("json_schema");
    }
  });

  it("500 must NOT fall back — it rejects with json_schema on every attempt", async () => {
    responses.push(apiError(500, "upstream exploded"));
    await expect(makeRunner().run(structuredParams())).rejects.toThrow();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      expect((call.body.response_format as Record<string, unknown> | undefined)?.type).toBe("json_schema");
    }
  });

  it("F4: tier1 200 with valid JSON that FAILS canonical validation resolves with the text (single call, legacy parser takes over)", async () => {
    responses.push(chatCompletion('{"not_scenes": []}'));
    const params = structuredParams();
    params.structuredOutput.validate = () => false; // canonical validation rejects
    const text = await makeRunner().run(params);
    expect(text).toBe('{"not_scenes": []}');
    expect(calls).toHaveLength(1); // never a second LLM call
  });

  it("NoObjectGeneratedError: unparseable 200 body resolves with the raw text, single LLM call", async () => {
    responses.push(chatCompletion("抱歉,我无法以 JSON 回答这个问题。"));
    const text = await makeRunner().run(structuredParams());

    expect(text).toBe("抱歉,我无法以 JSON 回答这个问题。");
    expect(calls).toHaveLength(1); // never a second LLM call
  });

  it("stream=true participates in structured output (json_schema over SSE)", async () => {
    responses.push(sseCompletion(['{"scenes":', '[{"scene_name":"', '行程"}]}']));
    const runner = makeRunner({ stream: true });
    const text = await runner.run(structuredParams());

    expect(text.replace(/\s+/g, "")).toBe('{"scenes":[{"scene_name":"行程"}]}');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.stream).toBe(true);
    expect((calls[0]!.body.response_format as Record<string, unknown>).type).toBe("json_schema");
    expect(runner.lastUsage).toEqual({ promptTokens: 3, completionTokens: 5, totalTokens: 8 });
  });

  it("F3: stream + json_schema capability-rejected (HTTP 400) degrades to json_object over SSE", async () => {
    responses.push(apiError(400, "response_format of type json_schema is not supported by this model"));
    responses.push(sseCompletion(['{"scenes":', "[}]}"]));
    const text = await makeRunner({ stream: true }).run(structuredParams());

    expect(text.replace(/\s+/g, "")).toBe('{"scenes":[}]}');
    expect(calls).toHaveLength(2);
    expect((calls[0]!.body.response_format as Record<string, unknown>).type).toBe("json_schema");
    expect((calls[1]!.body.response_format as Record<string, unknown>).type).toBe("json_object");
    expect(calls[1]!.body.stream).toBe(true);
  });

  it("F3: stream + both structured modes rejected degrades to plain SSE text (no response_format)", async () => {
    responses.push(apiError(400, "response_format is not supported on this endpoint"));
    responses.push(apiError(422, "json_object mode is not supported"));
    responses.push(sseCompletion(["[]"]));
    const text = await makeRunner({ stream: true }).run(structuredParams());

    expect(text).toBe("[]");
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body.response_format).toBeUndefined();
    expect(calls[2]!.body.stream).toBe(true);
  });

  it("stream=true: validation failure resolves with the raw streamed text (single call)", async () => {
    responses.push(sseCompletion(["<think>推理</think>", "这不是 JSON"]));
    const text = await makeRunner({ stream: true }).run(structuredParams());

    expect(text).toContain("<think>推理</think>");
    expect(calls).toHaveLength(1);
  });

  it("tools-enabled runs ignore structuredOutput and keep the plain tool flow", async () => {
    responses.push(chatCompletion("tool-driven text output"));
    const runner = makeRunner({ enableTools: true });
    const text = await runner.run({
      ...structuredParams(),
      tools: {
        read: tool({
          description: "read",
          inputSchema: jsonSchema<{ path: string }>({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
          execute: async () => "ok",
        }),
      },
      enableTools: true,
    });

    expect(text).toBe("tool-driven text output");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.response_format).toBeUndefined();
    expect(calls[0]!.body.tools).toBeDefined();
  });

  it("without structuredOutput the request has no response_format (existing behavior)", async () => {
    responses.push(chatCompletion("plain"));
    const text = await makeRunner().run({ prompt: "p", taskId: "t" });
    expect(text).toBe("plain");
    expect(calls[0]!.body.response_format).toBeUndefined();
  });
});
