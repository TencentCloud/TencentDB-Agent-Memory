import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { StandaloneLLMRunner, type StandaloneLLMConfig } from "./llm-runner.js";
import {
  PromptContextLimitError,
  probeLlmCapabilities,
} from "./llm-capabilities.js";

interface TestEndpoint {
  baseUrl: string;
  requests: Array<{ url: string; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

const endpoints: TestEndpoint[] = [];

async function startEndpoint(
  handler: (
    req: http.IncomingMessage,
    body: Record<string, unknown>,
  ) => { status?: number; body: Record<string, unknown> },
): Promise<TestEndpoint> {
  const requests: TestEndpoint["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      requests.push({ url: req.url ?? "", body });
      const response = handler(req, body);
      res.writeHead(response.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  const endpoint: TestEndpoint = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
  endpoints.push(endpoint);
  return endpoint;
}

function chatResponse(model: string): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };
}

afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
});

describe("standalone local LLM capabilities", () => {
  it("probes an Ollama model and sends explicit reasoning controls", async () => {
    const endpoint = await startEndpoint((req) => {
      if (req.url === "/api/show") {
        return {
          body: {
            parameters: "temperature 0.7\nnum_ctx 8192",
            model_info: { "qwen3.context_length": 32768 },
            capabilities: ["completion", "tools", "thinking"],
          },
        };
      }
      return { body: chatResponse("qwen3:8b") };
    });
    const config: StandaloneLLMConfig = {
      baseUrl: endpoint.baseUrl,
      apiKey: "ollama",
      model: "qwen3:8b",
      maxTokens: 1024,
      backend: "ollama",
      reasoning: { enabled: false },
      extraBody: { keep_alive: "5m", model: "must-not-override" },
    };

    const capability = await probeLlmCapabilities(config);
    expect(capability).toMatchObject({
      state: "ready",
      backend: "ollama",
      effectiveContextWindow: 8192,
      effectiveInputBudgetTokens: 7168,
      extraBodyKeys: ["keep_alive"],
    });
    config.effectiveContextWindow = capability.effectiveContextWindow;

    const result = await new StandaloneLLMRunner({ config }).run({
      taskId: "ollama-compatible-integration",
      systemPrompt: "Be brief.",
      prompt: "Hello",
    });
    expect(result).toBe("ok");
    const chat = endpoint.requests.find((request) => request.url === "/v1/chat/completions");
    expect(chat?.body).toMatchObject({
      model: "qwen3:8b",
      reasoning_effort: "none",
      keep_alive: "5m",
    });
  });

  it("never widens an operator context cap to an Ollama model training limit", async () => {
    const endpoint = await startEndpoint((req) => {
      if (req.url === "/api/show") {
        return {
          body: {
            model_info: { "qwen35.context_length": 262144 },
            capabilities: ["completion", "thinking"],
          },
        };
      }
      return { body: chatResponse("qwen3.6:27b") };
    });
    const capability = await probeLlmCapabilities({
      baseUrl: endpoint.baseUrl,
      apiKey: "ollama",
      model: "qwen3.6:27b",
      maxTokens: 2048,
      backend: "ollama",
      contextWindow: 8192,
    });
    expect(capability).toMatchObject({
      state: "ready",
      configuredContextWindow: 8192,
      effectiveContextWindow: 8192,
      effectiveInputBudgetTokens: 6144,
    });
  });

  it("probes llama.cpp and applies Jinja reasoning/template options", async () => {
    const endpoint = await startEndpoint((req) => {
      if (req.url === "/health") return { body: { status: "ok" } };
      if (req.url === "/props") {
        return {
          body: {
            default_generation_settings: { n_ctx: 16384 },
            chat_template: "qwen3",
            chat_template_caps: { supports_tool_calls: true, supports_reasoning: true },
          },
        };
      }
      return { body: chatResponse("qwen3.5-27b") };
    });
    const config: StandaloneLLMConfig = {
      baseUrl: endpoint.baseUrl,
      apiKey: "local",
      model: "qwen3.5-27b",
      maxTokens: 2048,
      backend: "llama.cpp",
      reasoning: { enabled: false, format: "none" },
      extraBody: { chat_template_kwargs: { custom_flag: "configured" } },
    };

    const capability = await probeLlmCapabilities(config);
    expect(capability).toMatchObject({
      state: "ready",
      backend: "llama.cpp",
      effectiveContextWindow: 16384,
      effectiveInputBudgetTokens: 14336,
    });
    config.effectiveContextWindow = capability.effectiveContextWindow;

    await new StandaloneLLMRunner({ config }).run({
      taskId: "llama-cpp-integration",
      prompt: "Extract memory",
    });
    const chat = endpoint.requests.find((request) => request.url === "/v1/chat/completions");
    expect(chat?.body).toMatchObject({
      model: "qwen3.5-27b",
      reasoning_format: "none",
      chat_template_kwargs: { custom_flag: "configured", enable_thinking: false },
    });
  });

  it("reports an unloaded model without reflecting response secrets", async () => {
    const endpoint = await startEndpoint(() => ({
      status: 404,
      body: { error: "model missing", reflected_api_key: "do-not-log-this" },
    }));
    const capability = await probeLlmCapabilities({
      baseUrl: endpoint.baseUrl,
      apiKey: "also-secret",
      model: "missing-model",
      backend: "ollama",
    });
    expect(capability.state).toBe("degraded");
    expect(capability.detail).toContain("Ollama /api/show returned HTTP 404");
    expect(JSON.stringify(capability)).not.toContain("do-not-log-this");
    expect(JSON.stringify(capability)).not.toContain("also-secret");
  });

  it("reports a context configuration which leaves no prompt budget", async () => {
    const endpoint = await startEndpoint((req) => {
      if (req.url === "/health") return { body: { status: "ok" } };
      return {
        body: {
          default_generation_settings: { n_ctx: 8192 },
          chat_template_caps: { supports_reasoning: true },
        },
      };
    });
    const capability = await probeLlmCapabilities({
      baseUrl: endpoint.baseUrl,
      apiKey: "local",
      model: "qwen",
      backend: "llama.cpp",
      maxTokens: 8192,
    });
    expect(capability.state).toBe("degraded");
    expect(capability.detail).toContain("maxTokens 8192 leaves no input budget in context window 8192");
  });

  it("refuses an oversized prompt before contacting the endpoint", async () => {
    const endpoint = await startEndpoint(() => ({ body: chatResponse("tiny") }));
    const runner = new StandaloneLLMRunner({
      config: {
        baseUrl: endpoint.baseUrl,
        apiKey: "local",
        model: "tiny",
        contextWindow: 64,
        inputBudgetTokens: 8,
      },
    });
    await expect(runner.run({
      taskId: "prompt-budget",
      prompt: "This request is deliberately longer than an eight token input budget.",
    })).rejects.toBeInstanceOf(PromptContextLimitError);
    expect(endpoint.requests).toHaveLength(0);
  });
});
