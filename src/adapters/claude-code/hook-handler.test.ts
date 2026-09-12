import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCodeGateway } from "./gateway-client.js";
import {
  createClaudeCodeSessionKey,
  handleClaudeCodeHook,
  type ClaudeCodeHookInput,
} from "./hook-handler.js";
import { ClaudeCodeStateStore } from "./state-store.js";

describe("Claude Code hook adapter", () => {
  let stateDir: string;
  let store: ClaudeCodeStateStore;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-claude-hook-"));
    store = new ClaudeCodeStateStore(stateDir);
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("recalls memory before a prompt and persists the pending turn", async () => {
    const gateway = fakeGateway();
    gateway.recall.mockResolvedValue({ context: "stable persona context" });
    gateway.searchMemories.mockResolvedValue({ results: "dynamic L1 memory" });
    const input = hookInput({
      hook_event_name: "UserPromptSubmit",
      prompt_id: "prompt-1",
      prompt: "Which database did I choose?",
    });

    const output = await handleClaudeCodeHook(input, {
      gateway,
      store,
      now: () => 1_000,
    });

    expect(output.hookSpecificOutput).toEqual({
      hookEventName: "UserPromptSubmit",
      additionalContext: expect.stringContaining("dynamic L1 memory"),
    });
    expect(output.hookSpecificOutput?.additionalContext).toContain("stable persona context");
    expect(gateway.recall).toHaveBeenCalledWith(
      "Which database did I choose?",
      createClaudeCodeSessionKey(input),
    );

    const state = await store.load(input.session_id, createClaudeCodeSessionKey(input));
    expect(state.turns).toEqual([
      {
        id: "prompt-1",
        userText: "Which database did I choose?",
        userTimestamp: 1_000,
      },
    ]);
  });

  it("captures the current turn from Stop without parsing a lagging transcript", async () => {
    const gateway = fakeGateway();
    const prompt = hookInput({
      hook_event_name: "UserPromptSubmit",
      prompt_id: "prompt-2",
      prompt: "Remember that I prefer SQLite.",
    });
    await handleClaudeCodeHook(prompt, { gateway, store, now: () => 2_000 });

    await handleClaudeCodeHook(
      hookInput({
        hook_event_name: "Stop",
        last_assistant_message: "I will remember your SQLite preference.",
      }),
      { gateway, store, now: () => 2_500 },
    );

    expect(gateway.capture).toHaveBeenCalledWith({
      userText: "Remember that I prefer SQLite.",
      assistantText: "I will remember your SQLite preference.",
      userTimestamp: 2_000,
      assistantTimestamp: 2_500,
      sessionKey: createClaudeCodeSessionKey(prompt),
      sessionId: "session-123",
    });
    const state = await store.load(prompt.session_id, createClaudeCodeSessionKey(prompt));
    expect(state.turns).toHaveLength(0);
  });

  it("retains a failed capture and retries it before the next prompt", async () => {
    const gateway = fakeGateway();
    gateway.capture.mockRejectedValueOnce(new Error("Gateway offline"));
    const firstPrompt = hookInput({
      hook_event_name: "UserPromptSubmit",
      prompt_id: "prompt-3",
      prompt: "First turn",
    });
    await handleClaudeCodeHook(firstPrompt, { gateway, store, now: () => 3_000 });
    await handleClaudeCodeHook(
      hookInput({ hook_event_name: "Stop", last_assistant_message: "First answer" }),
      { gateway, store, now: () => 3_500 },
    );

    let state = await store.load(firstPrompt.session_id, createClaudeCodeSessionKey(firstPrompt));
    expect(state.turns[0]).toMatchObject({
      userText: "First turn",
      assistantText: "First answer",
    });

    await handleClaudeCodeHook(
      hookInput({
        hook_event_name: "UserPromptSubmit",
        prompt_id: "prompt-4",
        prompt: "Second turn",
      }),
      { gateway, store, now: () => 4_000 },
    );

    expect(gateway.capture).toHaveBeenCalledTimes(2);
    state = await store.load(firstPrompt.session_id, createClaudeCodeSessionKey(firstPrompt));
    expect(state.turns).toEqual([
      { id: "prompt-4", userText: "Second turn", userTimestamp: 4_000 },
    ]);
  });

  it("flushes SessionEnd and discards only an incomplete prompt", async () => {
    const input = hookInput({ hook_event_name: "SessionEnd", reason: "other" });
    const sessionKey = createClaudeCodeSessionKey(input);
    await store.save({
      version: 1,
      sessionId: input.session_id,
      sessionKey,
      turns: [
        { id: "incomplete", userText: "abandoned", userTimestamp: 1 },
        {
          id: "retryable",
          userText: "captured later",
          userTimestamp: 2,
          assistantText: "answer",
          assistantTimestamp: 3,
        },
      ],
    });
    const gateway = fakeGateway();

    await handleClaudeCodeHook(input, { gateway, store });

    expect(gateway.endSession).toHaveBeenCalledWith(sessionKey);
    const state = await store.load(input.session_id, sessionKey);
    expect(state.turns.map((turn) => turn.id)).toEqual(["retryable"]);
  });

  it("caps injected context below Claude Code's 10,000-character file fallback", async () => {
    const gateway = fakeGateway();
    gateway.searchMemories.mockResolvedValue({ results: "x".repeat(1_000) });

    const output = await handleClaudeCodeHook(
      hookInput({ hook_event_name: "UserPromptSubmit", prompt: "recall" }),
      { gateway, store, maxContextChars: 240 },
    );

    expect(output.hookSpecificOutput?.additionalContext).toHaveLength(240);
    expect(output.hookSpecificOutput?.additionalContext.endsWith("[Recalled context truncated]"))
      .toBe(true);
  });

  it("fails open when recall and search are unavailable", async () => {
    const gateway = fakeGateway();
    gateway.recall.mockRejectedValue(new Error("offline"));
    gateway.searchMemories.mockRejectedValue(new Error("offline"));

    await expect(handleClaudeCodeHook(
      hookInput({ hook_event_name: "UserPromptSubmit", prompt: "continue anyway" }),
      { gateway, store },
    )).resolves.toEqual({});
  });
});

function hookInput(overrides: Partial<ClaudeCodeHookInput>): ClaudeCodeHookInput {
  return {
    session_id: "session-123",
    cwd: path.join("workspace", "project"),
    hook_event_name: "UserPromptSubmit",
    ...overrides,
  };
}

function fakeGateway() {
  return {
    recall: vi.fn<ClaudeCodeGateway["recall"]>().mockResolvedValue({}),
    searchMemories: vi.fn<ClaudeCodeGateway["searchMemories"]>().mockResolvedValue({}),
    capture: vi.fn<ClaudeCodeGateway["capture"]>().mockResolvedValue(undefined),
    endSession: vi.fn<ClaudeCodeGateway["endSession"]>().mockResolvedValue(undefined),
  };
}
