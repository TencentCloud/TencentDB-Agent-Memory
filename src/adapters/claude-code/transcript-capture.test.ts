import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryTools } from "../mcp/tools.js";
import { handleClaudeCodeHook } from "./hooks.js";

const tempDirs: string[] = [];

async function createDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-tencentdb-claude-code-transcript-"));
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

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

async function writeTranscript(dir: string, entries: Record<string, unknown>[]): Promise<string> {
  const file = path.join(dir, "session.jsonl");
  await writeFile(file, `${entries.map(line).join("\n")}\n`);
  return file;
}

const TURN_ONE = [
  { type: "user", uuid: "u1", promptId: "p1", message: { role: "user", content: "fix the build" } },
  { type: "assistant", uuid: "a1", message: { role: "assistant", content: [
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
  ] } },
  { type: "user", uuid: "u2", promptId: "p1", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "t1", content: "1 failing" },
  ] } },
  { type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "text", text: "Fixed it." }] } },
];

describe("SessionEnd transcript capture", () => {
  it("sends the transcript delta before flushing the session and records a marker", async () => {
    const stateDir = await createDir();
    const transcriptPath = await writeTranscript(await createDir(), TURN_ONE);
    const tools = createTools();

    await handleClaudeCodeHook(
      { hook_event_name: "SessionEnd", session_id: "s1", cwd: "/proj", reason: "exit", transcript_path: transcriptPath },
      { stateDir, tools },
    );

    expect(tools.capture).toHaveBeenCalledTimes(1);
    const request = vi.mocked(tools.capture).mock.calls[0][0];
    expect(request.sessionKey).toBe("claude-code:s1");
    expect(request.sessionId).toBe("s1");
    expect(request.userContent).toBe("fix the build");
    expect(request.assistantContent).toBe("Fixed it.");
    expect(request.messages).toEqual([
      { id: "claude-code:s1:u1", role: "user", content: "fix the build" },
      { id: "claude-code:s1:a1", role: "assistant", content: '[tool_use id=t1 name=Bash input={"command":"npm test"}]' },
      { id: "claude-code:s1:u2", role: "user", content: "[tool_result tool_use_id=t1] 1 failing" },
      { id: "claude-code:s1:a2", role: "assistant", content: "Fixed it." },
    ]);
    expect(tools.endSession).toHaveBeenCalledWith({ sessionKey: "claude-code:s1" });
    expect(vi.mocked(tools.capture).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(tools.endSession).mock.invocationCallOrder[0]);

    // A second SessionEnd of the same session (a resume that ends again) sends nothing new.
    await handleClaudeCodeHook(
      { hook_event_name: "SessionEnd", session_id: "s1", cwd: "/proj", reason: "exit", transcript_path: transcriptPath },
      { stateDir, tools },
    );
    expect(tools.capture).toHaveBeenCalledTimes(1);
    expect(tools.endSession).toHaveBeenCalledTimes(2);
  });

  it("sends the whole turn at Stop when the transcript is available, and SessionEnd then has nothing left", async () => {
    const stateDir = await createDir();
    const transcriptPath = await writeTranscript(await createDir(), TURN_ONE);
    const tools = createTools();

    await handleClaudeCodeHook(
      { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: "/proj", prompt: "fix the build" },
      { stateDir, tools },
    );
    await handleClaudeCodeHook(
      { hook_event_name: "Stop", session_id: "s1", prompt_id: "p1", cwd: "/proj", stop_hook_active: false, last_assistant_message: "Fixed it.", transcript_path: transcriptPath },
      { stateDir, tools },
    );

    expect(tools.capture).toHaveBeenCalledTimes(1);
    const request = vi.mocked(tools.capture).mock.calls[0][0];
    expect(request.userContent).toBe("fix the build");
    expect(request.assistantContent).toBe("Fixed it.");
    expect(request.messages?.map((message) => (message as { content: string }).content)).toEqual([
      "fix the build",
      '[tool_use id=t1 name=Bash input={"command":"npm test"}]',
      "[tool_result tool_use_id=t1] 1 failing",
      "Fixed it.",
    ]);

    // The turn is marked captured: a repeated Stop and the SessionEnd send nothing more.
    await handleClaudeCodeHook(
      { hook_event_name: "Stop", session_id: "s1", prompt_id: "p1", cwd: "/proj", stop_hook_active: false, last_assistant_message: "Fixed it.", transcript_path: transcriptPath },
      { stateDir, tools },
    );
    await handleClaudeCodeHook(
      { hook_event_name: "SessionEnd", session_id: "s1", cwd: "/proj", reason: "exit", transcript_path: transcriptPath },
      { stateDir, tools },
    );
    expect(tools.capture).toHaveBeenCalledTimes(1);
    expect(tools.endSession).toHaveBeenCalledTimes(1);
  });

  it("leaves a turn unclaimed when its Stop-time send fails, so SessionEnd sends it", async () => {
    const stateDir = await createDir();
    const transcriptPath = await writeTranscript(await createDir(), TURN_ONE);
    const capture = vi.fn()
      .mockRejectedValueOnce(new Error("gateway down"))
      .mockResolvedValue({ l0Recorded: 4, schedulerNotified: true });
    const tools = createTools({ capture });
    const log = vi.fn();

    await handleClaudeCodeHook(
      { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: "/proj", prompt: "fix the build" },
      { stateDir, tools, log },
    );
    await handleClaudeCodeHook(
      { hook_event_name: "Stop", session_id: "s1", prompt_id: "p1", cwd: "/proj", stop_hook_active: false, last_assistant_message: "Fixed it.", transcript_path: transcriptPath },
      { stateDir, tools, log },
    );
    expect(capture).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("transcript capture failed open"));

    await handleClaudeCodeHook(
      { hook_event_name: "SessionEnd", session_id: "s1", cwd: "/proj", reason: "exit", transcript_path: transcriptPath },
      { stateDir, tools, log },
    );
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[1][0].messages).toHaveLength(4);
  });

  it("leaves out what the Stop hook already captured for a turn", async () => {
    const stateDir = await createDir();
    const transcriptPath = await writeTranscript(await createDir(), TURN_ONE);
    const tools = createTools();

    await handleClaudeCodeHook(
      { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: "/proj", prompt: "fix the build" },
      { stateDir, tools },
    );
    await handleClaudeCodeHook(
      { hook_event_name: "Stop", session_id: "s1", prompt_id: "p1", cwd: "/proj", stop_hook_active: false, last_assistant_message: "Fixed it." },
      { stateDir, tools },
    );
    expect(tools.capture).toHaveBeenCalledTimes(1);

    await handleClaudeCodeHook(
      { hook_event_name: "SessionEnd", session_id: "s1", cwd: "/proj", reason: "exit", transcript_path: transcriptPath },
      { stateDir, tools },
    );

    expect(tools.capture).toHaveBeenCalledTimes(2);
    const request = vi.mocked(tools.capture).mock.calls[1][0];
    expect(request.messages).toEqual([
      { id: "claude-code:s1:a1", role: "assistant", content: '[tool_use id=t1 name=Bash input={"command":"npm test"}]' },
      { id: "claude-code:s1:u2", role: "user", content: "[tool_result tool_use_id=t1] 1 failing" },
    ]);
  });

  it("keeps the marker where the last successful batch ended when the Gateway fails", async () => {
    const stateDir = await createDir();
    const entries = Array.from({ length: 150 }, (_, index) => (
      index % 2 === 0
        ? { type: "user", uuid: `u${index}`, promptId: `p${index}`, message: { role: "user", content: `prompt ${index}` } }
        : { type: "assistant", uuid: `a${index}`, message: { role: "assistant", content: [{ type: "text", text: `answer ${index}` }] } }
    ));
    const transcriptPath = await writeTranscript(await createDir(), entries);
    const capture = vi.fn()
      .mockResolvedValueOnce({ l0Recorded: 100, schedulerNotified: true })
      .mockRejectedValueOnce(new Error("gateway down"))
      .mockResolvedValue({ l0Recorded: 50, schedulerNotified: true });
    const tools = createTools({ capture });
    const log = vi.fn();
    const endInput = { hook_event_name: "SessionEnd" as const, session_id: "s1", cwd: "/proj", reason: "exit", transcript_path: transcriptPath };

    await handleClaudeCodeHook(endInput, { stateDir, tools, log });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[0][0].messages).toHaveLength(100);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("capture failed open"));

    // Retry: only the second batch (50 messages) is left.
    await handleClaudeCodeHook(endInput, { stateDir, tools, log });
    expect(capture).toHaveBeenCalledTimes(3);
    expect(capture.mock.calls[2][0].messages).toHaveLength(50);
    expect(capture.mock.calls[2][0].messages[0].content).toBe("prompt 100");
  });

  it("can be switched off and never blocks the session flush", async () => {
    const stateDir = await createDir();
    const transcriptPath = await writeTranscript(await createDir(), TURN_ONE);
    const tools = createTools();
    vi.stubEnv("TDAI_CLAUDE_CODE_TRANSCRIPT_CAPTURE", "off");
    try {
      await handleClaudeCodeHook(
        { hook_event_name: "SessionEnd", session_id: "s1", cwd: "/proj", reason: "exit", transcript_path: transcriptPath },
        { stateDir, tools },
      );
    } finally {
      vi.unstubAllEnvs();
    }
    expect(tools.capture).not.toHaveBeenCalled();
    expect(tools.endSession).toHaveBeenCalledTimes(1);

    // No transcript at all: still flushes.
    await handleClaudeCodeHook(
      { hook_event_name: "SessionEnd", session_id: "s2", cwd: "/nowhere", reason: "exit", transcript_path: "/does/not/exist.jsonl" },
      { stateDir, tools, claudeConfigDir: stateDir },
    );
    expect(tools.capture).not.toHaveBeenCalled();
    expect(tools.endSession).toHaveBeenCalledTimes(2);
  });
});
