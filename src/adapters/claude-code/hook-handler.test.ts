import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildSessionKey,
  extractLatestTurn,
  handleClaudeCodeHook,
  type ClaudeCodeHookClient,
} from "./hook-handler.js";

function createClient(): ClaudeCodeHookClient {
  return {
    health: vi.fn(async () => ({ status: "ok" })),
    recall: vi.fn(async () => ({ context: "<memory>use pnpm</memory>" })),
    capture: vi.fn(async () => ({ l0_recorded: 2 })),
    endSession: vi.fn(async () => ({ flushed: true })),
  };
}

function writeTranscript(rows?: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-claude-hook-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, (rows ?? [
    JSON.stringify({
      cwd: "/tmp/project",
      sessionId: "s1",
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "remember pnpm" }] },
    }),
    JSON.stringify({
      cwd: "/tmp/project",
      sessionId: "s1",
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "noted" }] },
    }),
  ]).map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n"));
  return file;
}

describe("Claude Code hook adapter", () => {
  it("returns additional context for UserPromptSubmit", async () => {
    const client = createClient();
    const result = await handleClaudeCodeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      cwd: "/tmp/project",
      prompt: "what package manager?",
    }, { client });

    expect(client.recall).toHaveBeenCalledWith({
      query: "what package manager?",
      sessionKey: "claude-code:s1",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "{}")).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "<memory>use pnpm</memory>",
      },
    });
  });

  it("captures the latest transcript turn on Stop", async () => {
    const client = createClient();
    const transcriptPath = writeTranscript();

    const result = await handleClaudeCodeHook({
      hook_event_name: "Stop",
      session_id: "s1",
      transcript_path: transcriptPath,
    }, { client });

    expect(result.exitCode).toBe(0);
    expect(client.capture).toHaveBeenCalledWith({
      userContent: "remember pnpm",
      assistantContent: "noted",
      sessionKey: "claude-code:s1",
      sessionId: "s1",
    });
  });

  it("extracts the latest turn from a Claude transcript", () => {
    const transcriptPath = writeTranscript();

    expect(extractLatestTurn({ transcript_path: transcriptPath })).toEqual({
      userContent: "remember pnpm",
      assistantContent: "noted",
    });
  });

  it("uses the stable Claude session id even when cwd changes", () => {
    expect(buildSessionKey({
      cwd: "/tmp/project",
      session_id: "abc",
    })).toBe("claude-code:abc");
    expect(buildSessionKey({
      cwd: "/tmp/project/packages/api",
      session_id: "abc",
    })).toBe("claude-code:abc");
  });

  it("combines dynamic L1 and stable recall context", async () => {
    const client = createClient();
    vi.mocked(client.recall).mockResolvedValue({
      context: "stable persona",
      prepend_context: "dynamic L1",
      append_system_context: [
        "stable persona",
        "<memory-tools-guide>unavailable tdai tools</memory-tools-guide>",
      ].join("\n\n"),
    });

    const result = await handleClaudeCodeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      prompt: "what package manager?",
    }, { client });

    expect(JSON.parse(result.stdout ?? "{}").hookSpecificOutput.additionalContext)
      .toBe("dynamic L1\n\nstable persona");
  });

  it("uses last_assistant_message when the transcript lags behind Stop", async () => {
    const client = createClient();
    const transcriptPath = writeTranscript([
      {
        type: "user",
        promptId: "old-prompt",
        message: { role: "user", content: [{ type: "text", text: "old prompt" }] },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "old reply" }] },
      },
      {
        type: "user",
        promptId: "current-prompt",
        timestamp: "2026-07-12T06:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "current prompt" }] },
      },
    ]);

    await handleClaudeCodeHook({
      hook_event_name: "Stop",
      session_id: "s1",
      prompt_id: "current-prompt",
      transcript_path: transcriptPath,
      last_assistant_message: "current reply",
    }, { client });

    expect(client.capture).toHaveBeenCalledWith({
      userContent: "current prompt",
      assistantContent: "current reply",
      sessionKey: "claude-code:s1",
      sessionId: "s1",
      messages: [
        { role: "user", content: "current prompt", timestamp: 1_783_836_000_000 },
        { role: "assistant", content: "current reply", timestamp: 1_783_836_000_001 },
      ],
      startedAt: 1_783_835_999_999,
    });
  });

  it("skips capture instead of pairing a current reply with an old prompt", async () => {
    const client = createClient();
    const transcriptPath = writeTranscript([
      {
        type: "user",
        promptId: "old-prompt",
        message: { role: "user", content: "old prompt" },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "old reply" }] },
      },
    ]);

    await handleClaudeCodeHook({
      hook_event_name: "Stop",
      session_id: "s1",
      prompt_id: "current-prompt",
      transcript_path: transcriptPath,
      last_assistant_message: "current reply",
    }, { client });

    expect(client.capture).not.toHaveBeenCalled();
  });

  it("does not treat tool results as user prompts", () => {
    const transcriptPath = writeTranscript([
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "inspect the build" }] },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash" }] },
      },
      {
        type: "user",
        sourceToolAssistantUUID: "assistant-tool-row",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "large command output" }],
        },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "the build passes" }] },
      },
    ]);

    expect(extractLatestTurn({ transcript_path: transcriptPath })).toEqual({
      userContent: "inspect the build",
      assistantContent: "the build passes",
    });
  });

  it("flushes on SessionEnd without capturing the last turn again", async () => {
    const client = createClient();

    const result = await handleClaudeCodeHook({
      hook_event_name: "SessionEnd",
      session_id: "s1",
      cwd: "/tmp/project",
    }, { client });

    expect(result).toEqual({ exitCode: 0 });
    expect(client.capture).not.toHaveBeenCalled();
    expect(client.endSession).toHaveBeenCalledWith("claude-code:s1");
  });

  it("fails open when the Gateway is unavailable", async () => {
    const client = createClient();
    vi.mocked(client.recall).mockRejectedValue(new Error("connection refused"));

    const result = await handleClaudeCodeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      prompt: "continue",
    }, { client });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("connection refused");
  });
});
