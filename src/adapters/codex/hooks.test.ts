import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryTools } from "../mcp/tools.js";
import { handleCodexHook } from "./hooks.js";

const tempDirs: string[] = [];

async function createStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-tencentdb-codex-"));
  tempDirs.push(dir);
  return dir;
}

function createTools(overrides: Partial<MemoryTools> = {}): MemoryTools {
  return {
    recall: vi.fn().mockResolvedValue({ context: "", strategy: undefined, memoryCount: 0 }),
    capture: vi.fn().mockResolvedValue({ l0Recorded: 2, schedulerNotified: true }),
    endSession: vi.fn().mockResolvedValue({ flushed: true }),
    searchMemories: vi.fn(),
    searchConversations: vi.fn(),
    ...overrides,
  } as MemoryTools;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("handleCodexHook", () => {
  it("recalls through MCP tools and returns additionalContext", async () => {
    const stateDir = await createStateDir();
    const recall = vi.fn().mockResolvedValue({
      context: "User prefers concise answers.",
      strategy: "hybrid",
      memoryCount: 1,
    });
    const tools = createTools({ recall });

    const output = await handleCodexHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/workspace/project",
        prompt: "How should this response be formatted?",
      },
      { stateDir, tools },
    );

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "<relevant-memories>\nUser prefers concise answers.\n</relevant-memories>",
      },
    });
    expect(recall).toHaveBeenCalledWith({
      query: "How should this response be formatted?",
      sessionKey: "codex:session-1",
    });
  });

  it("captures the cached turn through MCP tools on Stop", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn().mockResolvedValue({ l0Recorded: 2, schedulerNotified: true });
    const tools = createTools({ capture });

    await handleCodexHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/workspace/project",
        prompt: "Implement the parser",
      },
      { stateDir, tools },
    );
    const output = await handleCodexHook(
      {
        hook_event_name: "Stop",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/workspace/project",
        stop_hook_active: false,
        last_assistant_message: "Implemented the parser and added tests.",
      },
      { stateDir, tools },
    );

    expect(output).toEqual({});
    expect(capture).toHaveBeenCalledWith({
      userContent: "Implement the parser",
      assistantContent: "Implemented the parser and added tests.",
      sessionKey: "codex:session-1",
      sessionId: "session-1",
      messages: [
        { id: "codex:session-1:turn-1:user", role: "user", content: "Implement the parser" },
        { id: "codex:session-1:turn-1:assistant", role: "assistant", content: "Implemented the parser and added tests." },
      ],
    });
  });

  it("fails open when MCP recall or capture tools fail", async () => {
    const stateDir = await createStateDir();
    const tools = createTools({
      recall: vi.fn().mockRejectedValue(new Error("MCP recall failed")),
      capture: vi.fn().mockRejectedValue(new Error("MCP capture failed")),
    });
    const log = vi.fn();

    const recallOutput = await handleCodexHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/workspace/project",
        prompt: "Keep working",
      },
      { stateDir, tools, log },
    );
    const stopOutput = await handleCodexHook(
      {
        hook_event_name: "Stop",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/workspace/project",
        stop_hook_active: false,
        last_assistant_message: "Work completed.",
      },
      { stateDir, tools, log },
    );

    expect(recallOutput).toEqual({});
    expect(stopOutput).toEqual({});
    expect(log).toHaveBeenCalledWith("MCP recall failed open: MCP recall failed");
    expect(log).toHaveBeenCalledWith("MCP capture failed open: MCP capture failed");
  });

  it("does not call session end because Codex exposes no SessionEnd hook", async () => {
    const stateDir = await createStateDir();
    const endSession = vi.fn();
    const tools = createTools({ endSession });

    await handleCodexHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/workspace/project",
        prompt: "Keep working",
      },
      { stateDir, tools },
    );

    expect(endSession).not.toHaveBeenCalled();
  });

  it("does not capture the same turn twice after a successful Stop", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn().mockResolvedValue({ l0Recorded: 2, schedulerNotified: true });
    const tools = createTools({ capture });

    await handleCodexHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/workspace/project",
        prompt: "Implement the parser",
      },
      { stateDir, tools },
    );
    const stopInput = {
      hook_event_name: "Stop" as const,
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: "/workspace/project",
      stop_hook_active: false,
      last_assistant_message: "Implemented the parser.",
    };
    await handleCodexHook(stopInput, { stateDir, tools });
    await handleCodexHook(stopInput, { stateDir, tools });

    expect(capture).toHaveBeenCalledOnce();
  });

  it("reuses stable message IDs when a failed capture is retried", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ l0Recorded: 0, schedulerNotified: false });
    const tools = createTools({ capture });
    const log = vi.fn();

    await handleCodexHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/workspace/project",
        prompt: "Retry this turn",
      },
      { stateDir, tools, log },
    );
    const stopInput = {
      hook_event_name: "Stop" as const,
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: "/workspace/project",
      stop_hook_active: false,
      last_assistant_message: "Completed after retry.",
    };

    await handleCodexHook(stopInput, { stateDir, tools, log });
    await handleCodexHook(stopInput, { stateDir, tools, log });
    await handleCodexHook(stopInput, { stateDir, tools, log });

    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[0][0].messages).toEqual([
      { id: "codex:session-1:turn-1:user", role: "user", content: "Retry this turn" },
      { id: "codex:session-1:turn-1:assistant", role: "assistant", content: "Completed after retry." },
    ]);
    expect(capture.mock.calls[1][0].messages).toEqual(capture.mock.calls[0][0].messages);
  });
});