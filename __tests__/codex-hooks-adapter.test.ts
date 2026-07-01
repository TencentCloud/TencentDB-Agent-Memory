import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildContext,
  createCodexPlatformAdapter,
  formatRecallAdditionalContext,
  handleStop,
  handleUserPromptSubmit,
  readStoredTurn,
} from "../scripts/codex-hooks-adapter/codex-hooks-adapter.js";
import { TdaiAdapterRuntime } from "../src/adapter-sdk/index.js";
import type {
  AdapterCaptureResult,
  AdapterCompletedTurn,
  AdapterConversationSearchParams,
  AdapterMemorySearchParams,
  AdapterRecallResult,
  MemoryAdapterOperations,
} from "../src/adapter-sdk/index.js";

describe("Codex hooks adapter", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function makeStateDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tdai-codex-hooks-"));
    tempDirs.push(dir);
    return dir;
  }

  it("maps Codex session ids to stable memory session keys", () => {
    const context = buildContext(
      {
        session_id: "codex/session 1",
        turn_id: "turn-1",
        hook_event_name: "UserPromptSubmit",
      },
      {
        gatewayUrl: "http://127.0.0.1:8420",
        timeoutMs: 1000,
        sessionPrefix: "codex",
        stateDir: "/tmp",
      },
    );

    expect(context).toEqual({
      sessionKey: "codex:codex_session_1",
      sessionId: "turn-1",
      userId: undefined,
    });
  });

  it("formats recall output as Codex additional developer context", () => {
    expect(formatRecallAdditionalContext({
      prependContext: "<memory>prefers SQLite tests</memory>",
      appendSystemContext: "<guide>search memory when context is missing</guide>",
    })).toContain("TencentDB Agent Memory recalled context");
  });

  it("recalls memory during UserPromptSubmit and stores the turn for Stop capture", async () => {
    const stateDir = await makeStateDir();
    const operations = new FakeOperations();
    const runtime = new TdaiAdapterRuntime({
      adapter: createCodexPlatformAdapter(),
      operations,
    });
    const input = {
      session_id: "session-1",
      turn_id: "turn-1",
      hook_event_name: "UserPromptSubmit",
      prompt: "Use my preferred local verification flow",
    };
    const context = buildContext(input, {
      gatewayUrl: "http://127.0.0.1:8420",
      timeoutMs: 1000,
      sessionPrefix: "codex",
      stateDir,
    });

    await expect(handleUserPromptSubmit(runtime, input, context, {
      gatewayUrl: "http://127.0.0.1:8420",
      timeoutMs: 1000,
      sessionPrefix: "codex",
      stateDir,
    })).resolves.toEqual({
      hookSpecificOutput: {
        additionalContext: expect.stringContaining("<relevant-memories>"),
      },
    });

    expect(operations.recallCalls).toEqual([{
      query: "Use my preferred local verification flow",
      sessionKey: "codex:session-1",
    }]);
    await expect(readStoredTurn(stateDir, input)).resolves.toMatchObject({
      userContent: "Use my preferred local verification flow",
      sessionKey: "codex:session-1",
    });
  });

  it("captures a completed Codex turn during Stop", async () => {
    const stateDir = await makeStateDir();
    const operations = new FakeOperations();
    const runtime = new TdaiAdapterRuntime({
      adapter: createCodexPlatformAdapter(),
      operations,
    });
    const submitInput = {
      session_id: "session-2",
      turn_id: "turn-2",
      hook_event_name: "UserPromptSubmit",
      prompt: "Remember that I want PR text aligned to issues",
    };
    const context = buildContext(submitInput, {
      gatewayUrl: "http://127.0.0.1:8420",
      timeoutMs: 1000,
      sessionPrefix: "codex",
      stateDir,
    });

    await handleUserPromptSubmit(runtime, submitInput, context, {
      gatewayUrl: "http://127.0.0.1:8420",
      timeoutMs: 1000,
      sessionPrefix: "codex",
      stateDir,
    });

    await expect(handleStop(runtime, {
      session_id: "session-2",
      turn_id: "turn-2",
      hook_event_name: "Stop",
      last_assistant_message: "I updated the PR body to match the issue acceptance criteria.",
    }, context, {
      gatewayUrl: "http://127.0.0.1:8420",
      timeoutMs: 1000,
      sessionPrefix: "codex",
      stateDir,
    })).resolves.toEqual({});

    expect(operations.captureCalls).toHaveLength(1);
    expect(operations.captureCalls[0]).toMatchObject({
      userText: "Remember that I want PR text aligned to issues",
      assistantText: "I updated the PR body to match the issue acceptance criteria.",
      sessionKey: "codex:session-2",
      sessionId: "turn-2",
      originalUserMessageCount: 1,
    });
    expect(operations.captureCalls[0].messages).toEqual([]);
    await expect(readStoredTurn(stateDir, submitInput)).resolves.toBeUndefined();
  });

  it("keeps the pending turn when Stop capture fails", async () => {
    const stateDir = await makeStateDir();
    const operations = new FakeOperations();
    operations.failCapture = true;
    const runtime = new TdaiAdapterRuntime({
      adapter: createCodexPlatformAdapter(),
      operations,
    });
    const submitInput = {
      session_id: "session-3",
      turn_id: "turn-3",
      hook_event_name: "UserPromptSubmit",
      prompt: "Remember this turn even if the Gateway is temporarily down",
    };
    const config = {
      gatewayUrl: "http://127.0.0.1:8420",
      timeoutMs: 1000,
      sessionPrefix: "codex",
      stateDir,
    };
    const context = buildContext(submitInput, config);

    await handleUserPromptSubmit(runtime, submitInput, context, config);
    await expect(handleStop(runtime, {
      session_id: "session-3",
      turn_id: "turn-3",
      hook_event_name: "Stop",
      last_assistant_message: "Gateway capture will fail in this test.",
    }, context, config)).resolves.toEqual({});

    expect(operations.captureCalls).toHaveLength(1);
    await expect(readStoredTurn(stateDir, submitInput)).resolves.toMatchObject({
      userContent: "Remember this turn even if the Gateway is temporarily down",
      sessionKey: "codex:session-3",
    });
  });

  it("keeps the pending turn when Gateway records zero L0 messages", async () => {
    const stateDir = await makeStateDir();
    const operations = new FakeOperations();
    operations.captureResultOverride = {
      l0RecordedCount: 0,
      schedulerNotified: true,
      l0VectorsWritten: 0,
      filteredMessages: [],
    };
    const runtime = new TdaiAdapterRuntime({
      adapter: createCodexPlatformAdapter(),
      operations,
    });
    const submitInput = {
      session_id: "session-4",
      turn_id: "turn-4",
      hook_event_name: "UserPromptSubmit",
      prompt: "Do not drop this turn if the Gateway filters it out",
    };
    const config = {
      gatewayUrl: "http://127.0.0.1:8420",
      timeoutMs: 1000,
      sessionPrefix: "codex",
      stateDir,
    };
    const context = buildContext(submitInput, config);

    await handleUserPromptSubmit(runtime, submitInput, context, config);
    await expect(handleStop(runtime, {
      session_id: "session-4",
      turn_id: "turn-4",
      hook_event_name: "Stop",
      last_assistant_message: "Gateway will acknowledge the request but record no L0 messages.",
    }, context, config)).resolves.toEqual({});

    await expect(readStoredTurn(stateDir, submitInput)).resolves.toMatchObject({
      userContent: "Do not drop this turn if the Gateway filters it out",
      sessionKey: "codex:session-4",
    });
  });
});

class FakeOperations implements MemoryAdapterOperations {
  recallCalls: Array<{ query: string; sessionKey: string }> = [];
  captureCalls: AdapterCompletedTurn[] = [];
  failCapture = false;
  captureResultOverride?: AdapterCaptureResult;

  async recall(query: string, sessionKey: string): Promise<AdapterRecallResult> {
    this.recallCalls.push({ query, sessionKey });
    return {
      prependContext: "<relevant-memories>codex recall</relevant-memories>",
      appendSystemContext: "<memory-tools-guide>capture useful turns</memory-tools-guide>",
    };
  }

  async capture(turn: AdapterCompletedTurn): Promise<AdapterCaptureResult> {
    this.captureCalls.push(turn);
    if (this.failCapture) {
      throw new Error("Gateway unavailable");
    }
    if (this.captureResultOverride) {
      return this.captureResultOverride;
    }
    return {
      l0RecordedCount: 2,
      schedulerNotified: true,
      l0VectorsWritten: 0,
      filteredMessages: [],
    };
  }

  async searchMemories(_params: AdapterMemorySearchParams): Promise<{ text: string; total: number; strategy: string }> {
    return { text: "", total: 0, strategy: "none" };
  }

  async searchConversations(_params: AdapterConversationSearchParams): Promise<{ text: string; total: number }> {
    return { text: "", total: 0 };
  }

  async endSession(): Promise<void> {}
}
