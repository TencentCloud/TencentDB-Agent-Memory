import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryTools } from "../mcp/tools.js";
import { handleClaudeCodeHook } from "./hooks.js";

const tempDirs: string[] = [];

async function createStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-tencentdb-claude-code-"));
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

describe("handleClaudeCodeHook", () => {
  it("recalls through MCP tools and returns additionalContext", async () => {
    const stateDir = await createStateDir();
    const recall = vi.fn().mockResolvedValue({
      context: "User prefers concise answers.",
      strategy: "hybrid",
      memoryCount: 1,
    });
    const tools = createTools({ recall });

    const output = await handleClaudeCodeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        prompt_id: "prompt-1",
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
      sessionKey: "claude-code:session-1",
    });
  });

  it("captures the cached turn through MCP tools on Stop", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn().mockResolvedValue({ l0Recorded: 2, schedulerNotified: true });
    const tools = createTools({ capture });

    await handleClaudeCodeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        prompt_id: "prompt-1",
        cwd: "/workspace/project",
        prompt: "Implement the parser",
      },
      { stateDir, tools },
    );
    const output = await handleClaudeCodeHook(
      {
        hook_event_name: "Stop",
        session_id: "session-1",
        prompt_id: "prompt-1",
        cwd: "/workspace/project",
        stop_hook_active: false,
        last_assistant_message: "Implemented the parser and added tests.",
        background_tasks: [],
        session_crons: [],
      },
      { stateDir, tools },
    );

    expect(output).toEqual({});
    expect(capture).toHaveBeenCalledWith({
      userContent: "Implement the parser",
      assistantContent: "Implemented the parser and added tests.",
      sessionKey: "claude-code:session-1",
      sessionId: "session-1",
      messages: [
        { id: "claude-code:session-1:prompt-1:user", role: "user", content: "Implement the parser" },
        { id: "claude-code:session-1:prompt-1:assistant", role: "assistant", content: "Implemented the parser and added tests." },
      ],
    });
  });

  it("captures the most recent pending prompt when prompt_id is unavailable", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn().mockResolvedValue({ l0Recorded: 2, schedulerNotified: true });
    const tools = createTools({ capture });

    await handleClaudeCodeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: "/workspace/project",
        prompt: "First prompt",
      },
      { stateDir, tools },
    );
    await handleClaudeCodeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: "/workspace/project",
        prompt: "Second prompt",
      },
      { stateDir, tools },
    );
    await handleClaudeCodeHook(
      {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: "/workspace/project",
        stop_hook_active: false,
        last_assistant_message: "Completed the second prompt.",
        background_tasks: [],
        session_crons: [],
      },
      { stateDir, tools },
    );

    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ userContent: "Second prompt" }));
  });

  it("captures consecutive turns when prompt_id is unavailable", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn().mockResolvedValue({ l0Recorded: 2, schedulerNotified: true });
    const tools = createTools({ capture });

    for (const [prompt, response] of [
      ["First prompt", "First response"],
      ["Second prompt", "Second response"],
    ]) {
      await handleClaudeCodeHook(
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "session-1",
          cwd: "/workspace/project",
          prompt,
        },
        { stateDir, tools },
      );
      await handleClaudeCodeHook(
        {
          hook_event_name: "Stop",
          session_id: "session-1",
          cwd: "/workspace/project",
          stop_hook_active: false,
          last_assistant_message: response,
          background_tasks: [],
          session_crons: [],
        },
        { stateDir, tools },
      );
    }

    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls.map(([input]) => input.userContent)).toEqual(["First prompt", "Second prompt"]);
    expect(capture.mock.calls[0][0].messages[0].id).not.toBe(capture.mock.calls[1][0].messages[0].id);
  });

  it("treats unavailable task registry fields as empty", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn().mockResolvedValue({ l0Recorded: 2, schedulerNotified: true });
    const tools = createTools({ capture });

    await handleClaudeCodeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        prompt_id: "prompt-1",
        cwd: "/workspace/project",
        prompt: "Implement the parser",
      },
      { stateDir, tools },
    );
    await handleClaudeCodeHook(
      {
        hook_event_name: "Stop",
        session_id: "session-1",
        prompt_id: "prompt-1",
        cwd: "/workspace/project",
        stop_hook_active: false,
        last_assistant_message: "Implemented the parser.",
      },
      { stateDir, tools },
    );

    expect(capture).toHaveBeenCalledOnce();
  });

  it.each([
    ["is already continuing from a Stop hook", { stop_hook_active: true, background_tasks: [], session_crons: [] }],
    ["has background tasks", { stop_hook_active: false, background_tasks: [{ id: "task-1" }], session_crons: [] }],
    ["has session crons", { stop_hook_active: false, background_tasks: [], session_crons: [{ id: "cron-1" }] }],
    ["has no assistant response", { stop_hook_active: false, background_tasks: [], session_crons: [], last_assistant_message: "" }],
  ])("does not capture when the turn %s", async (_description, overrides) => {
    const stateDir = await createStateDir();
    const capture = vi.fn();
    const tools = createTools({ capture });

    await handleClaudeCodeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        prompt_id: "prompt-1",
        cwd: "/workspace/project",
        prompt: "Implement the parser",
      },
      { stateDir, tools },
    );
    await handleClaudeCodeHook(
      {
        hook_event_name: "Stop",
        session_id: "session-1",
        prompt_id: "prompt-1",
        cwd: "/workspace/project",
        stop_hook_active: false,
        last_assistant_message: "Completed.",
        background_tasks: [],
        session_crons: [],
        ...overrides,
      },
      { stateDir, tools },
    );

    expect(capture).not.toHaveBeenCalled();
  });

  it("does not capture the same turn twice after a successful Stop", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn().mockResolvedValue({ l0Recorded: 2, schedulerNotified: true });
    const tools = createTools({ capture });

    await handleClaudeCodeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        prompt_id: "prompt-1",
        cwd: "/workspace/project",
        prompt: "Implement the parser",
      },
      { stateDir, tools },
    );
    const stopInput = {
      hook_event_name: "Stop" as const,
      session_id: "session-1",
      prompt_id: "prompt-1",
      cwd: "/workspace/project",
      stop_hook_active: false,
      last_assistant_message: "Implemented the parser.",
      background_tasks: [],
      session_crons: [],
    };
    await handleClaudeCodeHook(stopInput, { stateDir, tools });
    await handleClaudeCodeHook(stopInput, { stateDir, tools });

    expect(capture).toHaveBeenCalledOnce();
  });

  it("retries a failed capture with stable message ids", async () => {
    const stateDir = await createStateDir();
    const capture = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ l0Recorded: 2, schedulerNotified: true });
    const tools = createTools({ capture });
    const log = vi.fn();

    await handleClaudeCodeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        prompt_id: "prompt-1",
        cwd: "/workspace/project",
        prompt: "Retry this turn",
      },
      { stateDir, tools, log },
    );
    const stopInput = {
      hook_event_name: "Stop" as const,
      session_id: "session-1",
      prompt_id: "prompt-1",
      cwd: "/workspace/project",
      stop_hook_active: false,
      last_assistant_message: "Completed after retry.",
      background_tasks: [],
      session_crons: [],
    };

    await handleClaudeCodeHook(stopInput, { stateDir, tools, log });
    await handleClaudeCodeHook(stopInput, { stateDir, tools, log });

    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[1][0].messages).toEqual(capture.mock.calls[0][0].messages);
    expect(log).toHaveBeenCalledWith("MCP capture failed open: temporary failure");
  });

  it("fails open when recall or session end tools fail", async () => {
    const stateDir = await createStateDir();
    const tools = createTools({
      recall: vi.fn().mockRejectedValue(new Error("MCP recall failed")),
      endSession: vi.fn().mockRejectedValue(new Error("MCP session end failed")),
    });
    const log = vi.fn();

    const recallOutput = await handleClaudeCodeHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        prompt_id: "prompt-1",
        cwd: "/workspace/project",
        prompt: "Keep working",
      },
      { stateDir, tools, log },
    );
    const sessionEndOutput = await handleClaudeCodeHook(
      {
        hook_event_name: "SessionEnd",
        session_id: "session-1",
        cwd: "/workspace/project",
        reason: "other",
      },
      { stateDir, tools, log },
    );

    expect(recallOutput).toEqual({});
    expect(sessionEndOutput).toEqual({});
    expect(log).toHaveBeenCalledWith("MCP recall failed open: MCP recall failed");
    expect(log).toHaveBeenCalledWith("MCP session end failed open: MCP session end failed");
  });

  it("flushes the session through MCP tools on SessionEnd", async () => {
    const stateDir = await createStateDir();
    const endSession = vi.fn().mockResolvedValue({ flushed: true });
    const tools = createTools({ endSession });

    const output = await handleClaudeCodeHook(
      {
        hook_event_name: "SessionEnd",
        session_id: "session-1",
        cwd: "/workspace/project",
        reason: "other",
      },
      { stateDir, tools },
    );

    expect(output).toEqual({});
    expect(endSession).toHaveBeenCalledWith({ sessionKey: "claude-code:session-1" });
  });
});