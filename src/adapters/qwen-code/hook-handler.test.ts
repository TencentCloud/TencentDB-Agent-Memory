import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QwenCodeGatewayClient } from "./gateway-client.js";
import { handleQwenCodeHook } from "./hook-handler.js";

describe("Qwen Code hook handler", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-qwen-code-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function clientWithFetch(fetchImpl: typeof fetch): QwenCodeGatewayClient {
    return new QwenCodeGatewayClient({
      baseUrl: "http://gateway.test",
      fetchImpl,
      timeoutMs: 1000,
    });
  }

  it("injects recalled memory as Qwen additionalContext", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          context: "Use npm test for this repository.",
          strategy: "hybrid",
          memory_count: 1,
        }),
        { status: 200 },
      ),
    );

    const output = await handleQwenCodeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        transcript_path: "",
        cwd: tempDir,
        timestamp: new Date().toISOString(),
        prompt: "How should I test this change?",
      },
      { client: clientWithFetch(fetchImpl as unknown as typeof fetch) },
    );

    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput?.["hookEventName"]).toBe("UserPromptSubmit");
    expect(output.hookSpecificOutput?.["additionalContext"]).toContain("Use npm test");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request.query).toBe("How should I test this change?");
    expect(request.session_key).toMatch(/^qwen:/);
  });

  it("captures the latest completed turn once from a Stop hook", async () => {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ id: "u1", message: { role: "user", content: "Remember our adapter plan." } }),
        JSON.stringify({ id: "a1", message: { role: "assistant", content: "I will use Qwen hooks." } }),
      ].join("\n"),
      "utf8",
    );

    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ l0_recorded: 2, scheduler_notified: true }), { status: 200 }),
    );
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);

    const input = {
      hook_event_name: "Stop",
      session_id: "s1",
      transcript_path: transcriptPath,
      cwd: tempDir,
      timestamp: new Date().toISOString(),
      last_assistant_message: "I will use Qwen hooks.",
    };

    await handleQwenCodeHook(input, { client, stateDir: path.join(tempDir, "state") });
    await handleQwenCodeHook(input, { client, stateDir: path.join(tempDir, "state") });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request.user_content).toBe("Remember our adapter plan.");
    expect(request.assistant_content).toBe("I will use Qwen hooks.");
    expect(request.messages).toEqual([
      { role: "user", content: "Remember our adapter plan." },
      { role: "assistant", content: "I will use Qwen hooks." },
    ]);
  });

  it("flushes session on SessionEnd", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ flushed: true }), { status: 200 }),
    );

    await handleQwenCodeHook(
      {
        hook_event_name: "SessionEnd",
        session_id: "s1",
        transcript_path: "",
        cwd: tempDir,
        timestamp: new Date().toISOString(),
      },
      { client: clientWithFetch(fetchImpl as unknown as typeof fetch) },
    );

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://gateway.test/session/end");
  });

  it("fails open when the Gateway is unavailable", async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);

    const output = await handleQwenCodeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        transcript_path: "",
        cwd: tempDir,
        timestamp: new Date().toISOString(),
        prompt: "Hello",
      },
      { client, logger: { warn } },
    );

    expect(output).toEqual({ continue: true, decision: "allow" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed open"));
  });
});
