/**
 * Tests for the adapter SDK: GatewayClient wire format + MemoryAdapter
 * orchestration (skip / format / error-swallowing) + Claude Code transcript
 * parsing. Uses a mocked global fetch — no live Gateway required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GatewayClient } from "./gateway-client.js";
import { MemoryAdapter } from "./adapter-core.js";
import { ClaudeCodeBinding, readLastTurn } from "../bindings/claude-code/binding.js";
import { CodexBinding } from "../bindings/codex/binding.js";

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn(
    async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GatewayClient", () => {
  it("maps recall response fields and sends snake_case body", async () => {
    const fetchMock = mockFetchOnce(200, {
      context: "ctx",
      strategy: "hybrid",
      memory_count: 3,
    });
    const client = new GatewayClient({ baseUrl: "http://gw:8420/" });
    const out = await client.recall({ query: "q", sessionKey: "s1", userId: "u1" });

    expect(out).toEqual({ context: "ctx", strategy: "hybrid", memoryCount: 3 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://gw:8420/recall");
    expect(JSON.parse(init!.body as string)).toEqual({
      query: "q",
      session_key: "s1",
      user_id: "u1",
    });
  });

  it("attaches Bearer token when apiKey set", async () => {
    const fetchMock = mockFetchOnce(200, { l0_recorded: 2, scheduler_notified: true });
    const client = new GatewayClient({ baseUrl: "http://gw:8420", apiKey: " secret " });
    const out = await client.capture({
      userContent: "u",
      assistantContent: "a",
      sessionKey: "s1",
    });
    expect(out).toEqual({ l0Recorded: 2, schedulerNotified: true });
    const init = fetchMock.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("throws GatewayError on non-2xx", async () => {
    mockFetchOnce(500, { error: "boom" });
    const client = new GatewayClient({ baseUrl: "http://gw:8420" });
    await expect(client.recall({ query: "q", sessionKey: "s" })).rejects.toThrow(/Gateway HTTP 500/);
  });
});

describe("MemoryAdapter", () => {
  const binding = new ClaudeCodeBinding({ userId: "u1" });

  it("skips recall when prompt is empty (no fetch)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new GatewayClient({ baseUrl: "http://gw:8420" });
    const adapter = new MemoryAdapter({ binding, client });

    const out = await adapter.handleRecall({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      prompt: "   ",
    });
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("formats recall into Claude Code additionalContext", async () => {
    mockFetchOnce(200, { context: "remembered", memory_count: 1 });
    const client = new GatewayClient({ baseUrl: "http://gw:8420" });
    const adapter = new MemoryAdapter({ binding, client });

    const out = (await adapter.handleRecall({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      prompt: "hi",
    })) as { hookSpecificOutput: { additionalContext: string } };

    expect(out.hookSpecificOutput.additionalContext).toContain("remembered");
  });

  it("returns null (not throw) when Gateway fails during recall", async () => {
    mockFetchOnce(503, { error: "down" });
    const client = new GatewayClient({ baseUrl: "http://gw:8420" });
    const adapter = new MemoryAdapter({ binding, client });
    const out = await adapter.handleRecall({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      prompt: "hi",
    });
    expect(out).toBeNull();
  });

  it("executes memory_search tool and clamps limit", async () => {
    const fetchMock = mockFetchOnce(200, { results: "r", total: 4, strategy: "hybrid" });
    const client = new GatewayClient({ baseUrl: "http://gw:8420" });
    const adapter = new MemoryAdapter({ binding, client });

    const out = await adapter.handleToolCall("memory_search", { query: "q", limit: "999" });
    expect(out).toMatchObject({ results: "r", total: 4 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.limit).toBe(20);
  });

  it("returns error object for unknown tool", async () => {
    const client = new GatewayClient({ baseUrl: "http://gw:8420" });
    const adapter = new MemoryAdapter({ binding, client });
    const out = await adapter.handleToolCall("nope", {});
    expect(out).toHaveProperty("error");
  });

  it("lists two tools", () => {
    const client = new GatewayClient({ baseUrl: "http://gw:8420" });
    const adapter = new MemoryAdapter({ binding, client });
    const names = adapter.listTools().map((t) => t.name);
    expect(names).toEqual(["memory_search", "conversation_search"]);
  });
});

describe("ClaudeCodeBinding.readLastTurn", () => {
  it("extracts last user + assistant from a transcript JSONL", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-tr-"));
    const p = path.join(dir, "t.jsonl");
    fs.writeFileSync(
      p,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "old" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "old-a" } }),
        JSON.stringify({ type: "user", message: { role: "user", content: "hello there" } }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "hi back" }] },
        }),
      ].join("\n"),
    );
    const turn = readLastTurn(p);
    expect(turn).toEqual({ user: "hello there", assistant: "hi back" });
  });

  it("returns null for a missing file", () => {
    expect(readLastTurn("/no/such/file.jsonl")).toBeNull();
  });
});

describe("CodexBinding (minimal binding proves single-interface reuse)", () => {
  it("parses agent-turn-complete into a capture input", () => {
    const binding = new CodexBinding({ userId: "u1", sessionKey: "sess" });
    const input = binding.parseCapture({
      type: "agent-turn-complete",
      "turn-id": "t1",
      "input-messages": ["do X"],
      "last-assistant-message": "done X",
    });
    expect(input).toEqual({
      userContent: "do X",
      assistantContent: "done X",
      sessionKey: "sess",
      userId: "u1",
    });
  });

  it("ignores non-turn-complete events", () => {
    const binding = new CodexBinding();
    expect(binding.parseCapture({ type: "other" })).toBeNull();
  });
});
