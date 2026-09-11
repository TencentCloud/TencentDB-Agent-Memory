import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeCodeMemoryAdapter } from "./claude-code/index.js";
import { CodeBuddyMemoryAdapter } from "./codebuddy/index.js";
import { CodexMemoryGatewayClient } from "./codex/index.js";
import { createMemoryAdapter } from "./sdk/index.js";

function mockFetch(responseBody: unknown) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch);
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("platform adapters", () => {
  it("uses registered built-in providers through provider config", async () => {
    const calls = mockFetch({ context: "configured memory" });

    const adapter = createMemoryAdapter({
      provider: "codebuddy",
      config: {
        baseUrl: "http://configured-gateway/",
        apiKey: "configured-secret",
        sessionKey: "/repo",
        userId: "leo",
      },
    });

    await adapter.recall({ query: "q" });

    expect(String(calls[0].input)).toBe("http://configured-gateway/recall");
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer configured-secret" });
    expect(JSON.parse(calls[0].init?.body as string)).toMatchObject({
      session_key: "codebuddy:/repo",
      user_id: "leo",
    });
  });

  it("creates Codex adapters from Codex-friendly environment variables", async () => {
    const calls = mockFetch({ context: "codex memory" });
    const adapter = CodexMemoryGatewayClient.fromEnv({
      MEMORY_TENCENTDB_GATEWAY_URL: "http://gateway.local/",
      MEMORY_TENCENTDB_GATEWAY_API_KEY: "codex-secret",
      CODEX_WORKSPACE: "/repo",
      CODEX_USER_ID: "leo",
    });

    await adapter.recall({ query: "q" });

    expect(String(calls[0].input)).toBe("http://gateway.local/recall");
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer codex-secret" });
    expect(JSON.parse(calls[0].init?.body as string)).toMatchObject({
      session_key: "codex:/repo",
      user_id: "leo",
    });
  });

  it("creates CodeBuddy adapters with CodeBuddy env fallbacks", async () => {
    const calls = mockFetch({ context: "codebuddy memory" });
    const adapter = CodeBuddyMemoryAdapter.fromEnv({
      CODEBUDDY_MEMORY_GATEWAY_URL: "http://codebuddy-gateway/",
      CODEBUDDY_MEMORY_API_KEY: "codebuddy-secret",
      CODEBUDDY_WORKSPACE: "/repo",
      CODEBUDDY_USER_ID: "drive888",
    });

    await adapter.recall({ query: "q" });

    expect(String(calls[0].input)).toBe("http://codebuddy-gateway/recall");
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer codebuddy-secret" });
    expect(JSON.parse(calls[0].init?.body as string)).toMatchObject({
      session_key: "codebuddy:/repo",
      user_id: "drive888",
    });
  });

  it("creates Claude Code adapters with Claude env fallbacks", async () => {
    const calls = mockFetch({ context: "claude memory" });
    const adapter = ClaudeCodeMemoryAdapter.fromEnv({
      CLAUDE_CODE_MEMORY_GATEWAY_URL: "http://claude-gateway/",
      CLAUDE_CODE_MEMORY_API_KEY: "claude-secret",
      CLAUDE_CODE_SESSION_ID: "thread-1",
      CLAUDE_CODE_USER_ID: "leo",
    });

    await adapter.capture({ userContent: "u", assistantContent: "a" });

    expect(String(calls[0].input)).toBe("http://claude-gateway/capture");
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer claude-secret" });
    expect(JSON.parse(calls[0].init?.body as string)).toMatchObject({
      session_key: "claude-code:thread-1",
      user_content: "u",
      assistant_content: "a",
      user_id: "leo",
    });
  });
});
