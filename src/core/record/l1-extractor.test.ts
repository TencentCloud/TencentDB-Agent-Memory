import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callLlmExtraction, MIN_CLEAN_CONTEXT_CHARS } from "./l1-extractor.js";
import { EXTRACT_MEMORIES_SYSTEM_PROMPT } from "../prompts/l1-extraction.js";

// ---- Helpers ---------------------------------------------------------------

/** Build a very short user message list. */
function tinyMessages() {
  return [
    {
      id: "m1",
      role: "user" as const,
      content: "hi",
      timestamp: 1,
    },
    {
      id: "m2",
      role: "assistant" as const,
      content: "hello",
      timestamp: 2,
    },
  ];
}

/** Build a long enough message list that the prompt exceeds MIN_CLEAN_CONTEXT_CHARS. */
function largeMessages() {
  const msgs = [];
  for (let i = 0; i < 20; i++) {
    msgs.push({
      id: `u${i}`,
      role: "user" as const,
      content: `user message number ${i} with a bunch of extra text so the prompt grows long enough to exceed the threshold reliably.  Adding even more filler to be safe.  filler filler filler filler filler.`,
      timestamp: i * 2,
    });
    msgs.push({
      id: `a${i}`,
      role: "assistant" as const,
      content: `assistant message number ${i} responding to the user above with a longer than average paragraph to keep the character count climbing.  More filler filler filler filler filler filler.`,
      timestamp: i * 2 + 1,
    });
  }
  return msgs;
}

/** A do-nothing logger (the debug sink is fine as long as calls don't throw). */
const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ---- Suite -----------------------------------------------------------------

describe("Issue #176: CleanContextRunner 76B stub threshold guard", () => {
  beforeEach(() => {
    // Reset any module-level mocks between tests.
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. Short prompt + no llmRunner → short-circuit (no CleanContextRunner) ──

  it("short-circuits with empty scene list when prompt < MIN_CLEAN_CONTEXT_CHARS and no llmRunner (76B stub guard)", async () => {
    const newMsgs = tinyMessages();
    const backgroundMsgs: typeof newMsgs = [];

    const scenes = await callLlmExtraction({
      newMessages: newMsgs,
      backgroundMessages: backgroundMsgs,
      config: {},
      logger: noopLogger,
      // Intentionally NO llmRunner → CleanContextRunner path
    });

    expect(scenes).toEqual([]);
    // Confirm guard log fired
    const guardLogs = (noopLogger.debug.mock.calls as unknown[] as string[][])
      .flat()
      .filter((msg) => typeof msg === "string" && msg.includes("STUB_SKIP"));
    expect(guardLogs.length).toBeGreaterThanOrEqual(1);
  });

  // ── 2. Short prompt BUT has llmRunner → NO short-circuit ──

  it("does NOT short-circuit short prompts when llmRunner is provided (host path)", async () => {
    const newMsgs = tinyMessages();
    const fakeRunner = {
      run: vi.fn().mockResolvedValue(
        // Minimal valid extraction JSON → one scene.
        JSON.stringify([
          {
            scene_name: "greeting",
            message_ids: ["m1", "m2"],
            memories: [
              { content: "用户打了招呼", type: "episodic", priority: 50, source_message_ids: ["m1"] },
            ],
          },
        ]),
      ),
    };

    const scenes = await callLlmExtraction({
      newMessages: newMsgs,
      backgroundMessages: [],
      config: {},
      logger: noopLogger,
      llmRunner: fakeRunner,
    });

    // Host runner path is untouched → the extraction result is returned.
    expect(scenes.length).toBe(1);
    expect(scenes[0].scene_name).toBe("greeting");
    expect(fakeRunner.run).toHaveBeenCalledTimes(1);

    // Guard must NOT have fired (we had an llmRunner).
    const guardLogs = (noopLogger.debug.mock.calls as unknown[] as string[][])
      .flat()
      .filter((msg) => typeof msg === "string" && msg.includes("STUB_SKIP"));
    expect(guardLogs).toHaveLength(0);
  });

  // ── 3. Long prompt + no llmRunner → CleanContextRunner path proceeds ──

  it("allows long prompts to proceed down the CleanContextRunner path", async () => {
    // We can't actually run the embedded agent without an OpenClaw dist,
    // but we can assert that the function *attempts* to call CleanContextRunner
    // by mocking its module constructor.
    const newMsgs = largeMessages();
    // Sanity-check: long prompt is indeed longer than MIN_CLEAN_CONTEXT_CHARS.
    const { formatExtractionPrompt } = await import("../prompts/l1-extraction.js");
    const userPrompt = formatExtractionPrompt({ newMessages: newMsgs, backgroundMessages: [] });
    const total = EXTRACT_MEMORIES_SYSTEM_PROMPT.length + userPrompt.length;
    expect(total).toBeGreaterThanOrEqual(MIN_CLEAN_CONTEXT_CHARS);

    // Mock CleanContextRunner before importing l1-extractor module again.
    let runnerRunCalled = false;
    const mockCleanContextRunner = vi.fn().mockImplementation(() => ({
      run: vi.fn().mockImplementation(async () => {
        runnerRunCalled = true;
        // Throw so we stop immediately (we don't care about the call result,
        // only that it reached runner.run instead of short-circuiting).
        throw new Error("__MOCKED_CLEAN_CONTEXT_RUNNER__");
      }),
    }));

    // Do a fresh module import so the mock takes effect.
    const { CleanContextRunner: _unset } = await vi.importMock("../../utils/clean-context-runner.js");
    // NOTE: vi.importMock with ESM hoists; we rewire via vi.doMock just below.
    // We assert via the runnerRunCalled boolean: if the guard didn't fire,
    // new CleanContextRunner(...).run() gets invoked and flips the flag before
    // our mock throws.
    //
    // In order to guarantee CleanContextRunner is replaced we import through a
    // fresh eval via vi.doMock + dynamic import.
    await vi.doMock("../../utils/clean-context-runner.js", () => ({
      CleanContextRunner: mockCleanContextRunner,
    }));
    // Re-import callLlmExtraction now that CleanContextRunner is mocked.
    const { callLlmExtraction: call2 } = await import("./l1-extractor.js");

    try {
      await call2({
        newMessages: newMsgs,
        backgroundMessages: [],
        config: {},
        logger: noopLogger,
      });
    } catch (err) {
      // Expected — the mock throws __MOCKED_CLEAN_CONTEXT_RUNNER__.
      expect(String(err)).toContain("__MOCKED_CLEAN_CONTEXT_RUNNER__");
    }

    // Crucially: CleanContextRunner.run was reached (guard did NOT fire).
    expect(runnerRunCalled).toBe(true);
    // Guard log should NOT be present (prompt was long enough).
    const guardLogs = (noopLogger.debug.mock.calls as unknown[] as string[][])
      .flat()
      .filter((msg) => typeof msg === "string" && msg.includes("STUB_SKIP"));
    expect(guardLogs).toHaveLength(0);
  });

  // ── 4. MIN_CLEAN_CONTEXT_CHARS constant sanity --------------------------

  it("MIN_CLEAN_CONTEXT_CHARS is a sensible value", () => {
    // Range sanity: not too low (wouldn't catch 76B stub) nor too high
    // (would skip real short-but-meaningful conversations).
    expect(MIN_CLEAN_CONTEXT_CHARS).toBeGreaterThanOrEqual(256);
    expect(MIN_CLEAN_CONTEXT_CHARS).toBeLessThanOrEqual(2048);
  });

  // ── 5. Empty input → also short-circuits (prompt length ≈ 0) ───────────

  it("returns an empty scene list for completely empty message input", async () => {
    const scenes = await callLlmExtraction({
      newMessages: [],
      backgroundMessages: [],
      config: {},
      logger: noopLogger,
    });

    expect(scenes).toEqual([]);
  });
});
