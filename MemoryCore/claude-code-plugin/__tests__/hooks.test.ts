import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { V3MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { loadConfig } from "../src/config.js";
import { handleHook, type HookDeps } from "../src/hooks/handler.js";
import { PluginState } from "../src/hooks/state.js";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tdai-cc-hooks-"));
  tempDirs.push(dir);
  return dir;
}

function fakeClient(overrides: Partial<Record<keyof V3MemoryClient, unknown>> = {}): V3MemoryClient {
  return {
    searchAtomic: vi.fn().mockResolvedValue({ items: [{ id: "m1", type: "instruction", content: "Ask tdai first.", score: 0.9 }] }),
    readCore: vi.fn().mockResolvedValue({ content: "PERSONA TEXT", created_at: null, updated_at: null }),
    listScenarios: vi.fn().mockResolvedValue({ entries: [{ path: "scene/a.md", summary: "about a", created_at: "", updated_at: "" }], total: 1 }),
    searchConversation: vi.fn().mockResolvedValue({ messages: [] }),
    addConversation: vi.fn().mockResolvedValue({ accepted_ids: ["x"], total_count: 1 }),
    readScenario: vi.fn(),
    ...overrides,
  } as unknown as V3MemoryClient;
}

async function deps(overrides: Partial<HookDeps> = {}): Promise<HookDeps & { client: V3MemoryClient; log: ReturnType<typeof vi.fn> }> {
  const stateDir = await tempDir();
  const config = loadConfig({ TDAI_CLAUDE_CODE_STATE_DIR: stateDir } as NodeJS.ProcessEnv);
  const client = fakeClient();
  const log = vi.fn();
  return {
    config,
    state: new PluginState(stateDir),
    recallClient: client,
    captureClient: client,
    log,
    claudeConfigDir: await tempDir(),
    ...overrides,
    client,
  } as HookDeps & { client: V3MemoryClient; log: ReturnType<typeof vi.fn> };
}

const TURN = [
  { type: "user", uuid: "u1", promptId: "p1", timestamp: "2026-09-06T01:00:00.000Z", message: { role: "user", content: "fix the build" } },
  { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } },
  { type: "user", uuid: "u2", promptId: "p1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "1 failing" }] } },
  { type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "text", text: "Fixed it." }] } },
];

async function writeTranscript(entries: Record<string, unknown>[]): Promise<string> {
  const file = path.join(await tempDir(), "session.jsonl");
  await writeFile(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return file;
}

describe("UserPromptSubmit", () => {
  it("injects persona, scenes, guide and L1 hits on the first prompt, L1 hits only afterwards", async () => {
    const d = await deps();
    const first = await handleHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: "/proj", prompt: "where is the deploy recipe?" }, d);
    const ctx = (first as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("<user-persona>\nPERSONA TEXT");
    expect(ctx).toContain("<scene-navigation>");
    expect(ctx).toContain("scene/a.md — about a");
    expect(ctx).toContain("<memory-tools-guide>");
    expect(ctx).toContain("[instruction] Ask tdai first.");
    expect(d.client.searchAtomic).toHaveBeenCalledWith({ query: "where is the deploy recipe?", limit: 5 });

    const second = await handleHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p2", cwd: "/proj", prompt: "and the host?" }, d);
    const ctx2 = (second as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(ctx2).not.toContain("<user-persona>");
    expect(ctx2).toContain("<relevant-memories>");
    expect(d.client.readCore).toHaveBeenCalledTimes(1);
  });

  it("fails open when the Gateway is down and retries the session block next prompt", async () => {
    const d = await deps();
    for (const key of ["searchAtomic", "readCore", "listScenarios"] as const) {
      (d.client[key] as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("down"));
    }
    await expect(handleHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: "/proj", prompt: "hi" }, d)).resolves.toEqual({});
    expect(await d.state.hasSessionFlag("s1", "session-context-sent")).toBe(false);
  });
});

describe("Stop", () => {
  it("sends the whole turn from the transcript as one conversation add and marks the turn captured", async () => {
    const d = await deps();
    const transcriptPath = await writeTranscript(TURN);
    await handleHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: "/proj", prompt: "fix the build" }, d);
    await handleHook({ hook_event_name: "Stop", session_id: "s1", prompt_id: "p1", cwd: "/proj", stop_hook_active: false, last_assistant_message: "Fixed it.", transcript_path: transcriptPath }, d);

    expect(d.client.addConversation).toHaveBeenCalledTimes(1);
    const request = vi.mocked(d.client.addConversation).mock.calls[0][0];
    expect(request.session_id).toBe("s1");
    expect(request.messages).toEqual([
      { id: "claude-code:s1:u1", role: "user", content: "fix the build", timestamp: "2026-09-06T01:00:00.000Z" },
      { id: "claude-code:s1:a1", role: "assistant", content: '[tool_use id=t1 name=Bash input={"command":"npm test"}]' },
      { id: "claude-code:s1:u2", role: "user", content: "[tool_result tool_use_id=t1] 1 failing" },
      { id: "claude-code:s1:a2", role: "assistant", content: "Fixed it." },
    ]);
    expect(await d.state.isCaptured("s1", "p1")).toBe(true);

    // Repeated Stop and SessionEnd send nothing more.
    await handleHook({ hook_event_name: "Stop", session_id: "s1", prompt_id: "p1", cwd: "/proj", stop_hook_active: false, last_assistant_message: "Fixed it.", transcript_path: transcriptPath }, d);
    await handleHook({ hook_event_name: "SessionEnd", session_id: "s1", cwd: "/proj", reason: "exit", transcript_path: transcriptPath }, d);
    expect(d.client.addConversation).toHaveBeenCalledTimes(1);
  });

  it("falls back to prompt + reply when no transcript can be read", async () => {
    const d = await deps();
    await handleHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: "/nowhere", prompt: "fix the build" }, d);
    await handleHook({ hook_event_name: "Stop", session_id: "s1", prompt_id: "p1", cwd: "/nowhere", stop_hook_active: false, last_assistant_message: "Fixed it.", transcript_path: "/does/not/exist.jsonl" }, d);
    expect(vi.mocked(d.client.addConversation).mock.calls[0][0].messages).toEqual([
      { id: "claude-code:s1:p1:user", role: "user", content: "fix the build" },
      { id: "claude-code:s1:p1:assistant", role: "assistant", content: "Fixed it." },
    ]);
    expect(await d.state.isCaptured("s1", "p1")).toBe(true);
  });

  it("skips capture while background tasks run, with no final message, or when capture is off", async () => {
    const d = await deps();
    await handleHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: "/proj", prompt: "x" }, d);
    await handleHook({ hook_event_name: "Stop", session_id: "s1", prompt_id: "p1", cwd: "/proj", stop_hook_active: false, last_assistant_message: "y", background_tasks: [{}] }, d);
    await handleHook({ hook_event_name: "Stop", session_id: "s1", prompt_id: "p1", cwd: "/proj", stop_hook_active: false, last_assistant_message: "" }, d);
    await handleHook({ hook_event_name: "Stop", session_id: "s1", prompt_id: "p1", cwd: "/proj", stop_hook_active: true, last_assistant_message: "y" }, d);
    expect(d.client.addConversation).not.toHaveBeenCalled();

    const off = await deps({ config: loadConfig({ TDAI_CAPTURE: "off", TDAI_CLAUDE_CODE_STATE_DIR: d.config.stateDir } as NodeJS.ProcessEnv) });
    await handleHook({ hook_event_name: "Stop", session_id: "s1", prompt_id: "p1", cwd: "/proj", stop_hook_active: false, last_assistant_message: "y" }, off);
    expect(off.client.addConversation).not.toHaveBeenCalled();
  });

  it("leaves a turn unclaimed when its send fails, so SessionEnd sends it", async () => {
    const d = await deps();
    const transcriptPath = await writeTranscript(TURN);
    vi.mocked(d.client.addConversation).mockRejectedValueOnce(new Error("gateway down"));
    await handleHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "p1", cwd: "/proj", prompt: "fix the build" }, d);
    await handleHook({ hook_event_name: "Stop", session_id: "s1", prompt_id: "p1", cwd: "/proj", stop_hook_active: false, last_assistant_message: "Fixed it.", transcript_path: transcriptPath }, d);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("failed open"));
    expect(await d.state.isCaptured("s1", "p1")).toBe(false);

    await handleHook({ hook_event_name: "SessionEnd", session_id: "s1", cwd: "/proj", reason: "exit", transcript_path: transcriptPath }, d);
    expect(d.client.addConversation).toHaveBeenCalledTimes(2);
    expect(vi.mocked(d.client.addConversation).mock.calls[1][0].messages).toHaveLength(4);
  });
});

describe("SessionEnd", () => {
  it("keeps the marker at the last batch that landed and resumes from there", async () => {
    const d = await deps();
    const entries = Array.from({ length: 150 }, (_, i) => (
      i % 2 === 0
        ? { type: "user", uuid: `u${i}`, promptId: `p${i}`, message: { role: "user", content: `prompt ${i}` } }
        : { type: "assistant", uuid: `a${i}`, message: { role: "assistant", content: [{ type: "text", text: `answer ${i}` }] } }
    ));
    const transcriptPath = await writeTranscript(entries);
    vi.mocked(d.client.addConversation)
      .mockResolvedValueOnce({ accepted_ids: [], total_count: 100 })
      .mockRejectedValueOnce(new Error("gateway down"))
      .mockResolvedValue({ accepted_ids: [], total_count: 150 });
    const end = { hook_event_name: "SessionEnd" as const, session_id: "s1", cwd: "/proj", reason: "exit", transcript_path: transcriptPath };

    await handleHook(end, d);
    expect(d.client.addConversation).toHaveBeenCalledTimes(2);
    expect(vi.mocked(d.client.addConversation).mock.calls[0][0].messages).toHaveLength(100);

    await handleHook(end, d);
    expect(d.client.addConversation).toHaveBeenCalledTimes(3);
    expect(vi.mocked(d.client.addConversation).mock.calls[2][0].messages).toHaveLength(50);
    expect(vi.mocked(d.client.addConversation).mock.calls[2][0].messages[0].content).toBe("prompt 100");
  });
});
