import { beforeEach, describe, expect, it, vi } from "vitest";

import { turnKey, type MemoryClientLike } from "../src/client.js";
import { createTencentDbMemoryExtension } from "../src/extension.js";

const ENTRY_TYPE = "tdai-memory-captured";

function validEnv(): Record<string, string | undefined> {
  return {
    TDAI_MEMORY_API_KEY: "k",
    TDAI_MEMORY_SERVICE_ID: "s",
    TDAI_MEMORY_TEAM_ID: "t",
    TDAI_MEMORY_AGENT_ID: "a",
    TDAI_MEMORY_USER_ID: "u",
  };
}

function makeClient(overrides: Partial<MemoryClientLike> = {}): MemoryClientLike {
  return {
    recall: vi.fn().mockResolvedValue({ atomic: [], scenarios: [], core: null, warnings: [] }),
    captureTurn: vi.fn().mockResolvedValue(undefined),
    captureSkill: vi.fn().mockResolvedValue(undefined),
    searchAtomic: vi.fn().mockResolvedValue([]),
    searchConversation: vi.fn().mockResolvedValue([]),
    check: vi.fn().mockResolvedValue(5),
    ...overrides,
  };
}

interface MockPi {
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
  tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
  commands: Map<string, { handler: (...args: unknown[]) => Promise<unknown> }>;
  entries: Array<{ type: string; customType: string; data: Record<string, unknown> }>;
  on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>): void;
  registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }): void;
  registerCommand(name: string, cmd: { handler: (...args: unknown[]) => Promise<unknown> }): void;
  appendEntry(type: string, data: Record<string, unknown>): void;
}

function makePi(): MockPi {
  return {
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
    entries: [],
    on(event, handler) {
      this.handlers.set(event, handler);
    },
    registerTool(tool) {
      this.tools.set(tool.name, tool);
    },
    registerCommand(name, cmd) {
      this.commands.set(name, cmd);
    },
    appendEntry(type, data) {
      this.entries.push({ type: "custom", customType: type, data });
    },
  };
}

function makeCtx(
  entries: Array<{ type: string; customType?: string; data?: unknown }> = [],
  signal?: AbortSignal,
): unknown {
  return {
    signal: signal ?? new AbortController().signal,
    sessionManager: {
      getSessionId: () => "test-session",
      getEntries: () => entries,
    },
    hasUI: true,
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  };
}

interface Harness {
  pi: MockPi;
  client: MemoryClientLike;
  warns: string[];
  currentTime: { value: number };
}

function setup(overrides: Partial<MemoryClientLike> = {}): Harness {
  const client = makeClient(overrides);
  const warns: string[] = [];
  const currentTime = { value: 1_000 };
  const ext = createTencentDbMemoryExtension({
    env: validEnv(),
    clientFactory: () => client,
    logger: { warn: (m: string) => warns.push(m) },
    now: () => currentTime.value,
  });
  const pi = makePi();
  ext(pi as unknown as never);
  return { pi, client, warns, currentTime };
}

async function runTurn(h: Harness, prompt: string, assistant: string): Promise<void> {
  const ctx = makeCtx(h.pi.entries);
  const before = h.pi.handlers.get("before_agent_start");
  const end = h.pi.handlers.get("agent_end");
  const settled = h.pi.handlers.get("agent_settled");
  if (!before || !end || !settled) throw new Error("handlers missing");
  await before({ prompt, systemPrompt: "" }, ctx);
  await end(
    {
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: assistant, stopReason: "stop" },
      ],
    },
    ctx,
  );
  await settled({}, ctx);
}

async function flush(h: Harness): Promise<void> {
  const settled = h.pi.handlers.get("agent_settled");
  if (!settled) throw new Error("agent_settled missing");
  await settled({}, makeCtx(h.pi.entries));
}

describe("createTencentDbMemoryExtension", () => {
  it("registers only the status command when config is invalid", () => {
    const ext = createTencentDbMemoryExtension({ env: {} });
    const pi = makePi();
    ext(pi as unknown as never);
    expect(pi.commands.has("tdai-memory-status")).toBe(true);
    expect(pi.tools.size).toBe(0);
    expect(pi.handlers.size).toBe(0);
  });

  it("injects recalled context into the system prompt on before_agent_start", async () => {
    const h = setup({
      recall: vi.fn().mockResolvedValue({
        atomic: [{ id: "1", type: "fact", content: "prefers concise answers" }],
        scenarios: [],
        core: null,
        warnings: [],
      }),
    });
    const ctx = makeCtx();
    const before = h.pi.handlers.get("before_agent_start")!;
    const result = (await before({ prompt: "hi", systemPrompt: "BASE" }, ctx)) as {
      systemPrompt: string;
    };
    expect(result.systemPrompt).toContain("BASE");
    expect(result.systemPrompt).toContain("BEGIN_TENCENTDB_RECALLED_MEMORY");
    expect(result.systemPrompt).toContain("prefers concise answers");
  });

  it("fails open when recall throws (returns undefined, warns)", async () => {
    const h = setup({ recall: vi.fn().mockRejectedValue(new Error("down")) });
    const ctx = makeCtx();
    const before = h.pi.handlers.get("before_agent_start")!;
    const result = await before({ prompt: "hi", systemPrompt: "BASE" }, ctx);
    expect(result).toBeUndefined();
    expect(h.warns.some((w) => w.includes("recall failed"))).toBe(true);
  });

  it("captures a completed turn on agent_settled (L0 + skill)", async () => {
    const h = setup();
    await runTurn(h, "what is 2+2", "4");
    expect(h.client.captureTurn).toHaveBeenCalledTimes(1);
    expect(h.client.captureSkill).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent flushes (reuses the in-flight promise)", async () => {
    let resolveCapture: () => void = () => {};
    const h = setup({
      captureTurn: vi.fn(
        () => new Promise<void>((resolve) => {
          resolveCapture = resolve;
        }),
      ),
    });
    const ctx = makeCtx();
    const before = h.pi.handlers.get("before_agent_start")!;
    const end = h.pi.handlers.get("agent_end")!;
    const settled = h.pi.handlers.get("agent_settled")!;
    // Stage a turn without awaiting settled, so its flush stays in flight on captureTurn.
    await before({ prompt: "q", systemPrompt: "" }, ctx);
    await end(
      {
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "a", stopReason: "stop" },
        ],
      },
      ctx,
    );
    const flush1 = settled({}, ctx); // enters doFlush, awaits captureTurn (pending)
    const flush2 = settled({}, ctx); // must reuse the in-flight flush, not re-enter doFlush
    const callsWhileInFlight = (h.client.captureTurn as ReturnType<typeof vi.fn>).mock.calls.length;
    resolveCapture();
    await Promise.all([flush1, flush2]);
    // Only one captureTurn call: the second flush reused the first's in-flight promise.
    expect((h.client.captureTurn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsWhileInFlight,
    );
  });

  it("waits for the forced flush during session_shutdown", async () => {
    let resolveCapture: () => void = () => {};
    let shutdownSettled = false;
    const h = setup({
      captureTurn: vi.fn(
        () => new Promise<void>((resolve) => {
          resolveCapture = resolve;
        }),
      ),
    });
    const ctx = makeCtx();
    const before = h.pi.handlers.get("before_agent_start")!;
    const end = h.pi.handlers.get("agent_end")!;
    const settled = h.pi.handlers.get("agent_settled")!;
    const shutdown = h.pi.handlers.get("session_shutdown")!;
    await before({ prompt: "q", systemPrompt: "" }, ctx);
    await end(
      {
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "a", stopReason: "stop" },
        ],
      },
      ctx,
    );
    const settledPromise = settled({}, ctx);
    await Promise.resolve();
    const shutdownPromise = shutdown({}, ctx).then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    resolveCapture();
    await Promise.all([settledPromise, shutdownPromise]);
    expect(shutdownSettled).toBe(true);
  });

  it("applies backoff and skips a non-forced flush right after a failure", async () => {
    const h = setup({
      captureTurn: vi.fn().mockRejectedValue(new Error("down")),
      captureSkill: vi.fn().mockRejectedValue(new Error("down")),
    });
    await runTurn(h, "q", "a"); // both pipelines fail, sets backoff
    const callsAfterFirst = (h.client.captureTurn as ReturnType<typeof vi.fn>).mock.calls.length;
    await flush(h); // now() < backoffUntil -> skipped
    expect((h.client.captureTurn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
  });

  it("dead-letters a turn after exceeding the retry limit", async () => {
    const h = setup({
      captureTurn: vi.fn().mockRejectedValue(new Error("down")),
      captureSkill: vi.fn().mockRejectedValue(new Error("down")),
    });
    await runTurn(h, "q", "a"); // retries = 1
    for (let i = 0; i < 4; i += 1) {
      h.currentTime.value += 100_000; // advance past backoff
      await flush(h);
    }
    expect(h.pi.entries.some((e) => e.data.dead === true)).toBe(true);
    expect(h.warns.some((w) => w.includes("giving up"))).toBe(true);
  });

  it("preserves the retry budget across session reloads", async () => {
    const turn = {
      sessionId: "pi:test-session",
      user: "old question",
      assistant: "old answer",
      capturedAtMs: 1,
      clientMessageId: "turn-with-four-failures",
    };
    const key = turnKey(turn);
    const h = setup({
      captureTurn: vi.fn().mockRejectedValue(new Error("down")),
      captureSkill: vi.fn().mockRejectedValue(new Error("down")),
    });
    const ctx = makeCtx([
      {
        type: "custom",
        customType: ENTRY_TYPE,
        data: {
          version: 5,
          key,
          l0: false,
          skill: false,
          retries: 4,
          turn,
        },
      },
    ]);

    const start = h.pi.handlers.get("session_start")!;
    await start({}, ctx);
    await vi.waitFor(() => {
      expect(h.pi.entries.some((entry) => entry.data.key === key && entry.data.dead === true)).toBe(
        true,
      );
    });
  });

  it("ignores retry counts on a v4 marker after session reload", async () => {
    const turn = {
      sessionId: "pi:test-session",
      user: "old question",
      assistant: "old answer",
      capturedAtMs: 1,
      clientMessageId: "v4-turn-with-retries",
    };
    const key = turnKey(turn);
    const h = setup({
      captureTurn: vi.fn().mockRejectedValue(new Error("down")),
      captureSkill: vi.fn().mockRejectedValue(new Error("down")),
    });
    const ctx = makeCtx([
      {
        type: "custom",
        customType: ENTRY_TYPE,
        data: {
          version: 4,
          key,
          l0: false,
          skill: false,
          retries: 4,
          turn,
        },
      },
    ]);

    const start = h.pi.handlers.get("session_start")!;
    await start({}, ctx);
    await vi.waitFor(() => {
      expect(
        h.pi.entries.some(
          (entry) => entry.data.key === key && entry.data.retries === 1 && entry.data.dead === false,
        ),
      ).toBe(true);
    });
    expect(h.pi.entries.some((entry) => entry.data.key === key && entry.data.dead === true)).toBe(
      false,
    );
  });

  it("does not restore a pending marker after a later dead marker", async () => {
    const turn = {
      sessionId: "pi:test-session",
      user: "old question",
      assistant: "old answer",
      capturedAtMs: 1,
      clientMessageId: "turn-dead",
    };
    const key = turnKey(turn);
    const h = setup();
    const ctx = makeCtx([
      { type: "custom", customType: ENTRY_TYPE, data: { version: 4, key, l0: false, skill: false, turn } },
      { type: "custom", customType: ENTRY_TYPE, data: { version: 4, key, l0: false, skill: false, dead: true } },
    ]);
    const start = h.pi.handlers.get("session_start")!;
    await start({}, ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.client.captureTurn).not.toHaveBeenCalled();
    expect(h.client.captureSkill).not.toHaveBeenCalled();
  });

  it("evicts the oldest pending capture when the queue is full", async () => {
    let resolveCapture: () => void = () => {};
    const h = setup({
      captureTurn: vi.fn(
        () => new Promise<void>((resolve) => {
          resolveCapture = resolve;
        }),
      ),
    });
    const ctx = makeCtx();
    // Block the first turn so it stays pending, then overflow the queue.
    const before = h.pi.handlers.get("before_agent_start")!;
    const end = h.pi.handlers.get("agent_end")!;
    const settled = h.pi.handlers.get("agent_settled")!;
    for (let i = 0; i < 70; i += 1) {
      await before({ prompt: "p" + i, systemPrompt: "" }, ctx);
      await end(
        { messages: [{ role: "user", content: "p" + i }, { role: "assistant", content: "a" + i, stopReason: "stop" }] },
        ctx,
      );
      // Do not await flush; let it queue. settled triggers a flush but it is unresolved.
      settled({}, ctx).catch(() => undefined);
    }
    resolveCapture();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.warns.some((w) => w.includes("pending queue full"))).toBe(true);
    expect(h.pi.entries.some((e) => e.data.dead === true)).toBe(true);
  });

  it("does not restore an evicted pending marker on session_start", async () => {
    const turn = {
      sessionId: "pi:test-session",
      user: "evicted question",
      assistant: "evicted answer",
      capturedAtMs: 1,
      clientMessageId: "turn-evicted",
    };
    const key = turnKey(turn);
    const h = setup();
    const ctx = makeCtx([
      { type: "custom", customType: ENTRY_TYPE, data: { version: 4, key, l0: false, skill: false, turn } },
      { type: "custom", customType: ENTRY_TYPE, data: { version: 4, key, l0: false, skill: false, dead: true } },
    ]);
    const start = h.pi.handlers.get("session_start")!;
    await start({}, ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.client.captureTurn).not.toHaveBeenCalled();
  });

  it("compensates a previously-failed pipeline on session_start reload", async () => {
    // Simulate a persisted pending marker from a prior session.
    const turn = {
      sessionId: "pi:test-session",
      user: "old question",
      assistant: "old answer",
      capturedAtMs: 1,
    };
    const key = turnKey(turn);
    const h = setup();
    const ctx = makeCtx([
      { type: "custom", customType: ENTRY_TYPE, data: { version: 4, key, l0: false, skill: false, turn } },
    ]);
    const start = h.pi.handlers.get("session_start")!;
    await start({}, ctx);
    await new Promise((r) => setTimeout(r, 10)); // let fire-and-forget flush complete
    expect(h.client.captureTurn).toHaveBeenCalledWith(
      expect.objectContaining({ user: "old question" }),
      expect.anything(),
    );
  });

  it("writes at most 2 marker entries per turn (pending + status)", async () => {
    const h = setup();
    await runTurn(h, "q", "a"); // succeeds -> 1 pending + 1 status
    const statusEntries = h.pi.entries.filter(
      (e) => e.data.key !== undefined && e.data.turn === undefined,
    );
    const pendingEntries = h.pi.entries.filter((e) => e.data.turn !== undefined);
    expect(pendingEntries.length).toBe(1);
    expect(statusEntries.length).toBe(1);
  });

  it("captures repeated identical user and assistant turns separately", async () => {
    const h = setup();
    await runTurn(h, "same", "same answer");
    await runTurn(h, "same", "same answer");
    expect(h.client.captureTurn).toHaveBeenCalledTimes(2);
    const keys = h.pi.entries
      .filter((e) => e.data.turn !== undefined)
      .map((e) => e.data.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("keeps earlier completed messages when a later agent_end ends with an error", async () => {
    const h = setup();
    const ctx = makeCtx(h.pi.entries);
    const before = h.pi.handlers.get("before_agent_start")!;
    const end = h.pi.handlers.get("agent_end")!;
    const settled = h.pi.handlers.get("agent_settled")!;
    await before({ prompt: "q1", systemPrompt: "" }, ctx);
    await before({ prompt: "q2", systemPrompt: "" }, ctx);
    await end(
      {
        messages: [
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1", stopReason: "stop" },
          { role: "user", content: "q2" },
          { role: "assistant", content: "failed", stopReason: "error" },
        ],
      },
      ctx,
    );
    await end({ messages: [{ role: "assistant", content: "a2", stopReason: "stop" }] }, ctx);
    await settled({}, ctx);
    expect(h.client.captureTurn).toHaveBeenCalledTimes(2);
    expect(h.client.captureTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ user: "q1", assistant: "a1" }),
      expect.anything(),
    );
    expect(h.client.captureTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ user: "q2", assistant: "a2" }),
      expect.anything(),
    );
  });

  it("returns redacted, untrusted-wrapped results from the memory_search tool", async () => {
    const h = setup({
      searchAtomic: vi.fn().mockResolvedValue([{ id: "1", type: "fact", content: "Bearer leak" }]),
    });
    const tool = h.pi.tools.get("tdai_memory_search")!;
    const result = (await tool.execute("id", { query: "x" }, new AbortController().signal)) as {
      content: Array<{ text: string }>;
      details: Record<string, unknown>;
    };
    expect(result.content[0]?.text).toContain("BEGIN_TENCENTDB_RECALLED_MEMORY");
    expect(result.content[0]?.text).not.toContain("leak");
    expect(result.details).toEqual({ count: 1 });
  });

  it("keeps conversation search results out of persisted details", async () => {
    const searchConversation = vi.fn().mockResolvedValue([
      { id: "1", role: "user", content: "api_key=leak", score: 0.9 },
    ]);
    const h = setup({ searchConversation });
    const tool = h.pi.tools.get("tdai_conversation_search")!;
    const signal = new AbortController().signal;
    const result = (await tool.execute(
      "id",
      { query: "history", limit: 7, sessionOnly: true },
      signal,
      undefined,
      makeCtx(),
    )) as {
      content: Array<{ text: string }>;
      details: Record<string, unknown>;
    };
    expect(result.content[0]?.text).toContain("BEGIN_TENCENTDB_RECALLED_MEMORY");
    expect(result.content[0]?.text).not.toContain("leak");
    expect(result.details).toEqual({ count: 1 });
    expect(searchConversation).toHaveBeenCalledWith("history", 7, "pi:test-session", signal);
  });

  it("throws when a tool search fails", async () => {
    const h = setup({ searchAtomic: vi.fn().mockRejectedValue(new Error("down")) });
    const tool = h.pi.tools.get("tdai_memory_search")!;
    await expect(tool.execute("id", { query: "x" }, new AbortController().signal)).rejects.toThrow(
      "Memory search failed: down",
    );
  });

  it("throws when conversation search fails", async () => {
    const h = setup({ searchConversation: vi.fn().mockRejectedValue(new Error("down")) });
    const tool = h.pi.tools.get("tdai_conversation_search")!;
    await expect(
      tool.execute(
        "id",
        { query: "x" },
        new AbortController().signal,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow("Conversation search failed: down");
  });

  it("reports count unavailable when check returns null", async () => {
    const h = setup({ check: vi.fn().mockResolvedValue(null) });
    const cmd = h.pi.commands.get("tdai-memory-status")!;
    const ctx = makeCtx();
    await cmd.handler([], ctx);
    const notify = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify;
    expect(notify.mock.calls[0]?.[0]).toContain("count unavailable");
  });

  it("reports the atomic memory count when check returns a number", async () => {
    const h = setup({ check: vi.fn().mockResolvedValue(5) });
    const cmd = h.pi.commands.get("tdai-memory-status")!;
    const ctx = makeCtx();
    await cmd.handler([], ctx);
    const notify = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify;
    expect(notify.mock.calls[0]?.[0]).toContain("5 atomic memories");
  });
});
