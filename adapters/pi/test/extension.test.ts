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

  it("returns redacted, untrusted-wrapped results from the memory_search tool", async () => {
    const h = setup({
      searchAtomic: vi.fn().mockResolvedValue([{ id: "1", type: "fact", content: "Bearer leak" }]),
    });
    const tool = h.pi.tools.get("tdai_memory_search")!;
    const result = (await tool.execute("id", { query: "x" }, new AbortController().signal)) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0]?.text).toContain("BEGIN_TENCENTDB_RECALLED_MEMORY");
    expect(result.content[0]?.text).not.toContain("leak");
  });

  it("returns isError when a tool search fails", async () => {
    const h = setup({ searchAtomic: vi.fn().mockRejectedValue(new Error("down")) });
    const tool = h.pi.tools.get("tdai_memory_search")!;
    const result = (await tool.execute("id", { query: "x" }, new AbortController().signal)) as {
      isError: boolean;
    };
    expect(result.isError).toBe(true);
  });

  it("reports count unavailable when check returns null", async () => {
    const h = setup({ check: vi.fn().mockResolvedValue(null) });
    const cmd = h.pi.commands.get("tdai-memory-status")!;
    const ctx = makeCtx();
    await cmd.handler([], ctx);
    const notify = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify;
    expect(notify.mock.calls[0]?.[0]).toContain("count unavailable");
  });
});
