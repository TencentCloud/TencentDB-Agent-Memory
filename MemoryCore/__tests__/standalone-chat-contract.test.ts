import { expect, it, vi } from "vitest";
import http from "node:http";
import { APICallError, tool, jsonSchema } from "ai";
import { StandaloneLLMRunner } from "../src/adapters/standalone/llm-runner.js";

for (const mode of ["text", "tools", "stream"] as const) {
  it(`uses the actual SDK Chat Completions contract for ${mode}`, async () => {
    const requests: Array<{ url?: string; authorization?: string; body: { model: string; stream?: boolean; tools?: Array<{ function: { name: string } }>; messages: Array<Record<string, unknown>> } }> = [];
    let executed = 0;
    const server = http.createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push({ url: req.url, authorization: req.headers.authorization, body });
      if (mode === "stream") {
        res.setHeader("Content-Type", "text/event-stream");
        for (const chunk of [
          { delta: { role: "assistant", content: "synthetic stream" }, finish_reason: null },
          { delta: {}, finish_reason: "stop" },
        ]) res.write(`data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "synthetic", choices: [{ index: 0, ...chunk }] })}\n\n`);
        res.end("data: [DONE]\n\n"); return;
      }
      const firstTool = mode === "tools" && requests.length === 1;
      const message = firstTool
        ? { role: "assistant", content: null, tool_calls: [{ id: "synthetic-call", type: "function", function: { name: "echo", arguments: '{"value":"synthetic input"}' } }] }
        : { role: "assistant", content: "synthetic result" };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "synthetic", object: "chat.completion", created: 1, model: "synthetic", choices: [{ index: 0, message, finish_reason: firstTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
      const runner = new StandaloneLLMRunner({ config: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "synthetic-key", model: "synthetic", stream: mode === "stream" } });
      const echo = tool({ inputSchema: jsonSchema<{ value: string }>({ type: "object", properties: { value: { type: "string" } }, required: ["value"] }), execute: async ({ value }) => { executed++; expect(value).toBe("synthetic input"); return "synthetic tool result"; } });
      expect(await runner.run({ taskId: "synthetic", prompt: "synthetic prompt", systemPrompt: "synthetic system", tools: { echo }, enableTools: mode === "tools" })).toBe(mode === "stream" ? "synthetic stream" : "synthetic result");
      expect(requests).toHaveLength(mode === "tools" ? 2 : 1);
      for (const request of requests) { expect(request.url).toBe("/v1/chat/completions"); expect(request.authorization).toBe("Bearer synthetic-key"); expect(request.body.model).toBe("synthetic"); }
      if (mode === "tools") {
        expect(executed).toBe(1); expect(requests[0].body.tools?.[0].function.name).toBe("echo");
        expect(requests[1].body.messages).toContainEqual(expect.objectContaining({ role: "tool", content: "synthetic tool result" }));
        expect(runner.lastUsage).toEqual({ promptTokens: 4, completionTokens: 6, totalTokens: 10 });
      } else { expect(executed).toBe(0); expect(requests[0].body.tools).toBeUndefined(); }
      expect(requests[0].body.stream).toBe(mode === "stream" ? true : undefined);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}


it("retains HTTP status but excludes real SDK error URL, body and message from runner logs", async () => {
  const marker = "synthetic-private-provider-data";
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: marker, type: "invalid_request_error" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const baseUrl = `http://127.0.0.1:${address.port}/${marker}/v1`;
    const runner = new StandaloneLLMRunner({ config: { baseUrl, apiKey: "synthetic-key", model: "synthetic" }, logger: log });
    let rejection: unknown;
    try { await runner.run({ taskId: "synthetic", prompt: "synthetic" }); } catch (err) { rejection = err; }
    expect(APICallError.isInstance(rejection)).toBe(true);
    expect(rejection).toMatchObject({ statusCode: 400, message: marker });
    const diagnostics = JSON.stringify(Object.values(log).map(fn => fn.mock.calls));
    expect(diagnostics).toContain("status=400");
    expect(diagnostics).not.toContain(marker);
    expect(diagnostics).not.toContain(baseUrl);
    expect(diagnostics).not.toContain("invalid_request_error");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
