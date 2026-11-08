import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonSchema, tool } from "ai";
import { createStrictOpenAICompatFetch } from "./strict-openai-compat.js";
import { StandaloneLLMRunner } from "./llm-runner.js";

afterEach(() => vi.unstubAllGlobals());

describe("strict OpenAI message content", () => {
  it("normalizes text arrays/null while retaining tool linkage and request options", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const signal = new AbortController().signal;
    const messages = [
      { role: "system", content: [{ type: "text", text: "one\n" }, { type: "text", text: "two" }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", content: [{ type: "text", text: "result" }], tool_call_id: "call-1" },
    ];
    const payload = { model: "model", messages, tools: [{ type: "function" }], stream: true };
    const init = { method: "POST", signal, headers: { Authorization: "Bearer test" }, body: JSON.stringify(payload) };
    await createStrictOpenAICompatFetch(fetchMock)("https://example.test/chat/completions", init);
    const sent = fetchMock.mock.calls[0][1]!;
    expect(sent.signal).toBe(signal);
    expect(sent.headers).toBe(init.headers);
    expect(sent.method).toBe("POST");
    expect(JSON.parse(sent.body as string)).toEqual({ ...payload, messages: [
      { ...messages[0], content: "one\ntwo" },
      { ...messages[1], content: "" },
      { ...messages[2], content: "result" },
    ] });
    expect(messages[1].content).toBeNull();
  });

  it.each([
    "not json", "null", "{}",
    JSON.stringify({ messages: [{ role: "user", content: "text" }] }),
    JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "caption" }, { type: "image_url", image_url: { url: "https://example.test/image" } }] }] }),
    JSON.stringify({ messages: [null, { role: "tool" }, { content: [{ type: "unknown", data: "keep" }] }] }),
  ])("preserves unsupported or already compatible bodies: %s", async (body) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const init = { body };
    await createStrictOpenAICompatFetch(fetchMock)("https://example.test", init);
    expect(fetchMock.mock.calls[0][1]).toBe(init);
  });

  it("preserves a non-string request body", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const init = { body: new Uint8Array([1, 2]) };
    await createStrictOpenAICompatFetch(fetchMock)("https://example.test", init);
    expect(fetchMock.mock.calls[0][1]).toBe(init);
  });
});

describe("real AI SDK tool loop against a strict mock endpoint", () => {
  it.each([
    { strictOpenAICompat: false, stream: false },
    { strictOpenAICompat: true, stream: false },
    { strictOpenAICompat: true, stream: true },
  ])("compatibility=$strictOpenAICompat streaming=$stream", async ({ strictOpenAICompat, stream }) => {
    const requests: any[] = [];
    const read = vi.fn().mockResolvedValue("scene content");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const body = JSON.parse(init!.body as string);
      requests.push(body);
      if (body.messages.some((m: any) => typeof m.content !== "string")) {
        return Response.json({ error: { message: "Bad input: content must be a string", type: "invalid_request_error" } }, { status: 400 });
      }
      const first = requests.length === 1;
      expect(body.stream === true).toBe(stream);
      if (stream) {
        const delta = first
          ? { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] }
          : { role: "assistant", content: "done" };
        const chunk = (delta: unknown, finish_reason: string | null) => ({
          id: "completion", object: "chat.completion.chunk", created: 1, model: "test-model",
          choices: [{ index: 0, delta, finish_reason }],
        });
        return new Response([
          chunk(delta, null), chunk({}, first ? "tool_calls" : "stop"),
        ].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return Response.json({
        id: "completion", object: "chat.completion", created: 1, model: "test-model",
        choices: [{ index: 0, finish_reason: first ? "tool_calls" : "stop", message: first
          ? { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] }
          : { role: "assistant", content: "done" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    }));
    const runner = new StandaloneLLMRunner({ config: {
      baseUrl: "https://strict.example.test/v1", apiKey: "test", model: "test-model", strictOpenAICompat, stream,
    } });
    const result = runner.run({ taskId: "compat-test", prompt: "Read the scene", enableTools: true,
      tools: { read: tool({ inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }), execute: read }) },
    });
    if (strictOpenAICompat) await expect(result).resolves.toBe("done");
    else await expect(result).rejects.toThrow("content must be a string");
    expect(read).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    const assistant = requests[1].messages.find((m: any) => m.role === "assistant");
    expect(assistant.content).toBe(strictOpenAICompat ? "" : null);
    expect(assistant.tool_calls[0].id).toBe("call-1");
    expect(requests[1].messages.find((m: any) => m.role === "tool")).toMatchObject({ tool_call_id: "call-1", content: "scene content" });
  });
});
