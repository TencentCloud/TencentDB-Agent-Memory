import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  captureMemory,
  recallMemory,
  searchConversations,
  searchMemories,
} from "../../integrations/opencode/tools/memory-tencentdb.js";
import {
  createMemoryTencentDbPlugin,
  resolveOpenCodeMemoryContext,
} from "../../integrations/opencode/plugins/memory-tencentdb.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenCode adapter", () => {
  it("documents MCP, custom tool, and plugin entry points", async () => {
    const config = await readFile(join(process.cwd(), "integrations/opencode/opencode.jsonc"), "utf-8");

    expect(config).toContain("\"memory-tencentdb\"");
    expect(config).toContain("memory-tencentdb-mcp.mjs");
    expect(config).toContain("./.opencode/tools/memory-tencentdb.ts");
    expect(config).toContain("./.opencode/plugins/memory-tencentdb.ts");
  });

  it("forwards custom tool calls to Gateway endpoints", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const gateway = {
      baseUrl: "http://127.0.0.1:8420",
      fetchImpl: (async (input, init) => {
        calls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse({ ok: true });
      }) as typeof fetch,
    };

    await recallMemory({ query: "issue 235", session_key: "session-a" }, gateway);
    await captureMemory({
      user_content: "remember this",
      assistant_content: "stored",
      session_key: "session-a",
      session_id: "run-a",
    }, gateway);
    await searchMemories({ query: "adapter", limit: 2, scene: "opencode" }, gateway);
    await searchConversations({ query: "adapter", session_key: "session-a" }, gateway);

    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8420/recall",
      "http://127.0.0.1:8420/capture",
      "http://127.0.0.1:8420/search/memories",
      "http://127.0.0.1:8420/search/conversations",
    ]);
    expect(calls[1].body).toMatchObject({
      user_content: "remember this",
      assistant_content: "stored",
      session_key: "session-a",
      session_id: "run-a",
    });
  });

  it("performs best-effort plugin recall, capture, and session flush", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const plugin = createMemoryTencentDbPlugin({
      baseUrl: "http://127.0.0.1:8420",
      fetchImpl: (async (input, init) => {
        calls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse({ ok: true, context: "memory" });
      }) as typeof fetch,
    });

    await plugin.onUserPrompt({
      session_id: "session-b",
      user_id: "user-b",
      prompt: "please remember adapters",
    });
    await plugin.onAssistantMessage({
      session_id: "session-b",
      user_id: "user-b",
      assistant_text: "adapters remembered",
    });
    await plugin.onSessionEnd({
      session_id: "session-b",
      user_id: "user-b",
    });

    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8420/recall",
      "http://127.0.0.1:8420/capture",
      "http://127.0.0.1:8420/session/end",
    ]);
    expect(calls[1].body).toMatchObject({
      user_content: "please remember adapters",
      assistant_content: "adapters remembered",
      session_key: "session-b",
      user_id: "user-b",
    });
  });

  it("falls back to a stable cwd-derived session key", () => {
    expect(resolveOpenCodeMemoryContext({ cwd: "/repo/app" }).sessionKey)
      .toMatch(/^opencode:cwd:[a-f0-9]{12}$/);
  });
});

