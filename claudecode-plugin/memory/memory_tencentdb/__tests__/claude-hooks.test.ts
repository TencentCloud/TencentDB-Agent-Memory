import { describe, expect, it, vi } from "vitest";
import {
  runCaptureHook,
  runRecallHook,
  runSessionEndHook,
  runSessionStartHook,
} from "../hooks/memory.js";

describe("Claude Code session lifecycle hooks", () => {
  it("checks Gateway health at session start without blocking Claude Code", async () => {
    const health = vi.fn().mockResolvedValue({ status: "ok" });
    await expect(runSessionStartHook({}, { health })).resolves.toEqual({ continue: true });
    expect(health).toHaveBeenCalledOnce();
  });

  it("flushes the memory session at session end", async () => {
    const endSession = vi.fn().mockResolvedValue({ flushed: true });
    await expect(runSessionEndHook(
      { session_id: "session-a" },
      { createAdapter: () => ({ endSession }) },
    )).resolves.toEqual({ continue: true });
    expect(endSession).toHaveBeenCalledOnce();
  });
});

describe("Claude Code recall hook", () => {
  it("caches the prompt and returns additional context", async () => {
    const writePrompt = vi.fn().mockResolvedValue(undefined);
    const prefetch = vi.fn().mockResolvedValue({ context: "The user's name is Wang Ke" });

    await expect(runRecallHook(
      { session_id: "session-a", prompt: "remember my name" },
      { writePrompt, createAdapter: () => ({ prefetch }) },
    )).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "The user's name is Wang Ke",
      },
    });
    expect(writePrompt).toHaveBeenCalledWith("session-a", "remember my name");
    expect(prefetch).toHaveBeenCalledWith("remember my name");
  });

  it("fails open when recall is unavailable", async () => {
    const warn = vi.fn();
    await expect(runRecallHook(
      { session_id: "session-a", prompt: "hello" },
      {
        writePrompt: vi.fn().mockResolvedValue(undefined),
        createAdapter: () => ({ prefetch: vi.fn().mockRejectedValue(new Error("offline")) }),
        logger: { warn },
      },
    )).resolves.toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "" },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });
});

describe("Claude Code capture hook", () => {
  it("captures cached content and deletes it after success", async () => {
    const captureTurn = vi.fn().mockResolvedValue({ l0_recorded: 1 });
    const deletePrompt = vi.fn().mockResolvedValue(undefined);

    await runCaptureHook(
      { session_id: "session-a", last_assistant_message: "I will remember it" },
      {
        readPrompt: vi.fn().mockResolvedValue("remember my name"),
        deletePrompt,
        readTranscript: vi.fn(),
        createAdapter: () => ({ captureTurn }),
      },
    );

    expect(captureTurn).toHaveBeenCalledWith({
      userText: "remember my name",
      assistantText: "I will remember it",
    });
    expect(deletePrompt).toHaveBeenCalledWith("session-a");
  });

  it("uses transcript fallback when the cache is unavailable", async () => {
    const captureTurn = vi.fn().mockResolvedValue({ l0_recorded: 1 });

    await runCaptureHook(
      { session_id: "session-a", transcript_path: "transcript.jsonl" },
      {
        readPrompt: vi.fn().mockResolvedValue(null),
        deletePrompt: vi.fn().mockResolvedValue(undefined),
        readTranscript: vi.fn().mockResolvedValue({
          userText: "fallback question",
          assistantText: "fallback answer",
        }),
        createAdapter: () => ({ captureTurn }),
      },
    );

    expect(captureTurn).toHaveBeenCalledWith({
      userText: "fallback question",
      assistantText: "fallback answer",
    });
  });

  it("retains the prompt when capture fails and ignores recursive stops", async () => {
    const deletePrompt = vi.fn();
    const warn = vi.fn();
    const deps = {
      readPrompt: vi.fn().mockResolvedValue("question"),
      deletePrompt,
      readTranscript: vi.fn(),
      createAdapter: () => ({ captureTurn: vi.fn().mockRejectedValue(new Error("offline")) }),
      logger: { warn },
    };

    await runCaptureHook({ session_id: "session-a", last_assistant_message: "answer" }, deps);
    await expect(runCaptureHook({ session_id: "session-a", stop_hook_active: true }, deps))
      .resolves.toEqual({ continue: true });

    expect(deletePrompt).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });
});
