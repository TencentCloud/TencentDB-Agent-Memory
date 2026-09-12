import { describe, expect, it } from "vitest";
import { GatewayMemoryClient } from "../gateway-client/index.js";
import {
  createClaudeCodeContextFromHookInput,
  createClaudeCodeGatewayAdapter,
  createClaudeCodeSessionKey,
} from "./index.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createClaudeCodeSessionKey", () => {
  it("builds a stable session key from workspace and conversation identity", () => {
    expect(
      createClaudeCodeSessionKey({
        workspaceDir: "C:\\work\\agent-repo\\",
        conversationId: "conversation-1",
      }),
    ).toBe("claude-code:C:/work/agent-repo:conversation-1");
  });

  it("falls back to the hook session id before the default session", () => {
    expect(
      createClaudeCodeSessionKey({
        workspaceDir: "/work/agent-repo",
        sessionId: "hook-session",
      }),
    ).toBe("claude-code:/work/agent-repo:hook-session");
  });
});

describe("createClaudeCodeContextFromHookInput", () => {
  it("maps the Claude Code hook identity fields into adapter context", () => {
    expect(
      createClaudeCodeContextFromHookInput(
        {
          session_id: "abc123",
          transcript_path: "/Users/me/.claude/projects/repo/abc123.jsonl",
          cwd: "/work/agent-repo",
          hook_event_name: "SessionEnd",
        },
        { userId: "developer" },
      ),
    ).toEqual({
      workspaceDir: "/work/agent-repo",
      sessionId: "abc123",
      userId: "developer",
    });
  });
});

describe("createClaudeCodeGatewayAdapter", () => {
  it("maps Claude Code hook operations onto the gateway adapter lifecycle", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new GatewayMemoryClient({
      baseUrl: "http://127.0.0.1:8420/",
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (String(url).endsWith("/capture")) {
          return jsonResponse({ l0_recorded: 1, scheduler_notified: true });
        }
        if (String(url).endsWith("/session/end")) {
          return jsonResponse({ flushed: true });
        }
        if (String(url).endsWith("/search/memories")) {
          return jsonResponse({ results: "memory hit", total: 1, strategy: "fts" });
        }
        if (String(url).endsWith("/search/conversations")) {
          return jsonResponse({ results: "conversation hit", total: 1 });
        }
        return jsonResponse({ context: "remembered context", strategy: "hybrid", memory_count: 2 });
      },
    });

    const adapter = createClaudeCodeGatewayAdapter({
      client,
      resolveContext: () => ({
        workspaceDir: "/work/agent-repo",
        conversationId: "conversation-1",
        sessionId: "hook-session",
        userId: "developer",
      }),
    });

    await adapter.prefetchForPrompt("what should I fix next?");
    await adapter.captureCompletedTurn({
      userText: "fix the adapter",
      assistantText: "patched the adapter",
      messages: [{ role: "user", content: "fix the adapter" }],
    });
    await adapter.searchMemories({ query: "adapter", limit: 3 });
    await adapter.searchConversations({ query: "adapter" });
    await adapter.flushSession();

    expect(adapter.platform).toBe("claude-code");
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:8420/recall",
        body: {
          query: "what should I fix next?",
          session_key: "claude-code:/work/agent-repo:conversation-1",
          user_id: "developer",
        },
      },
      {
        url: "http://127.0.0.1:8420/capture",
        body: {
          user_content: "fix the adapter",
          assistant_content: "patched the adapter",
          messages: [{ role: "user", content: "fix the adapter" }],
          session_key: "claude-code:/work/agent-repo:conversation-1",
          session_id: "hook-session",
          user_id: "developer",
        },
      },
      {
        url: "http://127.0.0.1:8420/search/memories",
        body: { query: "adapter", limit: 3 },
      },
      {
        url: "http://127.0.0.1:8420/search/conversations",
        body: {
          query: "adapter",
          session_key: "claude-code:/work/agent-repo:conversation-1",
        },
      },
      {
        url: "http://127.0.0.1:8420/session/end",
        body: {
          session_key: "claude-code:/work/agent-repo:conversation-1",
          user_id: "developer",
        },
      },
    ]);
  });

  it("requires either an explicit session key or a workspace directory", async () => {
    const adapter = createClaudeCodeGatewayAdapter({
      client: new GatewayMemoryClient({
        baseUrl: "http://127.0.0.1:8420",
        fetchImpl: async () => jsonResponse({ context: "", strategy: "none", memory_count: 0 }),
      }),
      resolveContext: () => ({ conversationId: "conversation-1" }),
    });

    await expect(adapter.prefetchForPrompt("hello")).rejects.toThrow(
      "Claude Code Gateway adapter requires either sessionKey or workspaceDir",
    );
  });
});
