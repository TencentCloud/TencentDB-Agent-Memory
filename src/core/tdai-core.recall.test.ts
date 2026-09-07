import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TdaiCore } from "./tdai-core.js";
import { parseConfig } from "../config.js";
import { performAutoRecall } from "./hooks/auto-recall.js";
import type { HostAdapter, Logger } from "./types.js";

// Mock only performAutoRecall; every other export stays real.
// TdaiCore imports the same resolved module, so this single mock covers it.
vi.mock("./hooks/auto-recall.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hooks/auto-recall.js")>();
  return { ...actual, performAutoRecall: vi.fn() };
});

const mockRecall = vi.mocked(performAutoRecall);

let tmpDir: string;
let warns: string[];

function makeCore(recallOverrides: Record<string, unknown> = {}): TdaiCore {
  warns = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (m) => warns.push(m),
    error: () => {},
  };
  const hostAdapter: HostAdapter = {
    hostType: "standalone",
    getRuntimeContext: () => ({
      userId: "default_user",
      sessionId: "",
      sessionKey: "",
      platform: "gateway",
      workspaceDir: tmpDir,
      dataDir: tmpDir,
    }),
    getLogger: () => logger,
    getLLMRunnerFactory: () => ({ createRunner: () => ({ run: async () => "" }) }),
  };
  const cfg = parseConfig({
    capture: { enabled: false },
    extraction: { enabled: false },
    recall: { enabled: true, ...recallOverrides },
  });
  // No initialize(): handleBeforeRecall works uninitialized (no store needed here).
  return new TdaiCore({ hostAdapter, config: cfg });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-120-core-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const S = "sess-1";

/** Manually-resolved promise for adversarial interleaving of concurrent recalls. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("TdaiCore.handleBeforeRecall — ephemeral + session-frozen (defaults)", () => {
  it("freezes the stable block on turn 1 and serves identical bytes on drift", async () => {
    const core = makeCore();

    mockRecall.mockResolvedValueOnce({
      prependContext: "<relevant-memories>\n- [episodic] m1\n</relevant-memories>",
      appendSystemContext: "STABLE-V1",
    });
    const t1 = await core.handleBeforeRecall("q1", S);
    expect(t1.appendSystemContext).toBe("STABLE-V1");
    expect(t1.stableContextCacheHit).toBe(false);
    expect(t1.injectionModeUsed).toBe("ephemeral");
    expect(t1.prependContext).toContain("m1");

    // Turn 2: persona.md was rewritten mid-session by L3 → candidate drifts
    mockRecall.mockResolvedValueOnce({
      prependContext: "<relevant-memories>\n- [episodic] m2\n</relevant-memories>",
      appendSystemContext: "STABLE-V2-REWRITTEN",
    });
    const t2 = await core.handleBeforeRecall("q2", S);
    expect(t2.appendSystemContext).toBe("STABLE-V1"); // frozen bytes win
    expect(t2.stableContextCacheHit).toBe(true);
    expect(t2.prependContext).toContain("m2"); // dynamic part still per-turn
  });

  it("A5 regression: recall timeout must not flicker the persona out", async () => {
    const core = makeCore();

    mockRecall.mockResolvedValueOnce({ appendSystemContext: "STABLE-V1" });
    await core.handleBeforeRecall("q1", S);

    // Turn 2: performAutoRecall times out → undefined
    mockRecall.mockResolvedValueOnce(undefined);
    const t2 = await core.handleBeforeRecall("q2", S);
    expect(t2.appendSystemContext).toBe("STABLE-V1");
    expect(t2.stableContextCacheHit).toBe(true);
    expect(t2.prependContext).toBeUndefined();
  });

  it("keeps memory search enabled every turn (skipMemorySearch=false)", async () => {
    const core = makeCore();
    mockRecall.mockResolvedValue({ appendSystemContext: "S" });
    await core.handleBeforeRecall("q1", S);
    await core.handleBeforeRecall("q2", S);
    for (const call of mockRecall.mock.calls) {
      expect(call[0].options?.skipMemorySearch).toBe(false);
    }
  });

  it("isolates sessions from each other", async () => {
    const core = makeCore();
    mockRecall.mockResolvedValueOnce({ appendSystemContext: "A1" });
    mockRecall.mockResolvedValueOnce({ appendSystemContext: "B1" });
    mockRecall.mockResolvedValueOnce({ appendSystemContext: "A2-drift" });

    await core.handleBeforeRecall("q", "sess-a");
    const b = await core.handleBeforeRecall("q", "sess-b");
    const a2 = await core.handleBeforeRecall("q", "sess-a");
    expect(b.appendSystemContext).toBe("B1");
    expect(a2.appendSystemContext).toBe("A1");
  });
});

describe("TdaiCore.handleBeforeRecall — stableContextPolicy=latest (legacy)", () => {
  it("recomposes the stable block every turn (drift passes through)", async () => {
    const core = makeCore({ stableContextPolicy: "latest" });

    mockRecall.mockResolvedValueOnce({ appendSystemContext: "V1" });
    mockRecall.mockResolvedValueOnce({ appendSystemContext: "V2" });
    const t1 = await core.handleBeforeRecall("q1", S);
    const t2 = await core.handleBeforeRecall("q2", S);
    expect(t1.appendSystemContext).toBe("V1");
    expect(t2.appendSystemContext).toBe("V2"); // legacy: latest bytes win
    expect(t2.stableContextCacheHit).toBe(false);
  });
});

describe("TdaiCore.handleBeforeRecall — injectionMode=session-stable", () => {
  it("folds turn-1 memories into the frozen block; later turns are byte-identical with no prependContext", async () => {
    const core = makeCore({ injectionMode: "session-stable" });

    const P1 = "<relevant-memories>\n- [episodic] turn-1 memory\n</relevant-memories>";
    mockRecall.mockResolvedValueOnce({ prependContext: P1, appendSystemContext: "STABLE" });

    const t1 = await core.handleBeforeRecall("q1", S);
    const expectedMerged = `STABLE\n\n${P1}`;
    expect(t1.appendSystemContext).toBe(expectedMerged);
    expect(t1.prependContext).toBeUndefined();
    expect(t1.injectionModeUsed).toBe("session-stable");

    // Turns 2..6: drifted candidates + fresh memories are all ignored
    const later: string[] = [];
    for (let n = 2; n <= 6; n++) {
      mockRecall.mockResolvedValueOnce({
        prependContext: `<relevant-memories>\n- [episodic] turn-${n}\n</relevant-memories>`,
        appendSystemContext: `STABLE-DRIFT-${n}`,
      });
      const t = await core.handleBeforeRecall(`q${n}`, S);
      expect(t.prependContext).toBeUndefined();
      expect(t.stableContextCacheHit).toBe(true);
      later.push(t.appendSystemContext ?? "");
    }
    expect(later).toEqual(Array(5).fill(expectedMerged));

    // L1 search actually skipped from turn 2 on
    const skipFlags = mockRecall.mock.calls.map((c) => c[0].options?.skipMemorySearch);
    expect(skipFlags).toEqual([false, true, true, true, true, true]);
  });

  it("empty turn-1 recall freezes an empty sentinel — no mid-session reappearance", async () => {
    const core = makeCore({ injectionMode: "session-stable" });

    mockRecall.mockResolvedValueOnce(undefined); // turn 1: nothing at all
    const t1 = await core.handleBeforeRecall("q1", S);
    expect(t1.appendSystemContext).toBeUndefined();
    expect(t1.prependContext).toBeUndefined();

    // Turn 2: memories now exist, but the session already decided "no block"
    mockRecall.mockResolvedValueOnce({
      prependContext: "<relevant-memories>late</relevant-memories>",
      appendSystemContext: "LATE-STABLE",
    });
    const t2 = await core.handleBeforeRecall("q2", S);
    expect(t2.appendSystemContext).toBeUndefined();
    expect(t2.prependContext).toBeUndefined();
    expect(mockRecall.mock.calls[1][0].options?.skipMemorySearch).toBe(true);
  });

  it("session-stable + latest is coerced to frozen semantics with a warning", async () => {
    const core = makeCore({ injectionMode: "session-stable", stableContextPolicy: "latest" });
    expect(warns.some((w) => w.includes("session-frozen"))).toBe(true);

    mockRecall.mockResolvedValueOnce({ appendSystemContext: "S1" });
    mockRecall.mockResolvedValueOnce({ appendSystemContext: "S2-drift" });
    const t1 = await core.handleBeforeRecall("q1", S);
    const t2 = await core.handleBeforeRecall("q2", S);
    expect(t1.appendSystemContext).toBe("S1");
    expect(t2.appendSystemContext).toBe("S1"); // frozen despite "latest"
  });
});

describe("TdaiCore.handleBeforeRecall — concurrent turn-1 recalls (TOCTOU)", () => {
  // Gateway serves concurrent /recall HTTP requests for the same session_key:
  // both can pass the pre-await freeze check, so the freeze decision must be
  // re-taken after the recall await. First completed freeze wins — a slower
  // concurrent recall must NOT overwrite it (that would hand out two different
  // byte sequences for one session and silently repoint later turns).

  it("session-stable: first completed freeze wins; the late result cannot overwrite it", async () => {
    const core = makeCore({ injectionMode: "session-stable" });

    const slow = deferred<Awaited<ReturnType<typeof performAutoRecall>>>();
    const fast = deferred<Awaited<ReturnType<typeof performAutoRecall>>>();
    mockRecall
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(() => fast.promise);

    // Both calls start before either recall resolves → both see "no freeze".
    const p1 = core.handleBeforeRecall("q1", S);
    const p2 = core.handleBeforeRecall("q1-concurrent", S);

    // Adversarial order: the SECOND call completes first and freezes its bytes.
    const P2 = "<relevant-memories>\n- [episodic] fast\n</relevant-memories>";
    fast.resolve({ prependContext: P2, appendSystemContext: "STABLE-FAST" });
    const t2 = await p2;
    const winner = `STABLE-FAST\n\n${P2}`;
    expect(t2.appendSystemContext).toBe(winner);
    expect(t2.stableContextCacheHit).toBe(false);

    // ...then the first call's slow recall lands with DIFFERENT bytes.
    slow.resolve({
      prependContext: "<relevant-memories>\n- [episodic] slow\n</relevant-memories>",
      appendSystemContext: "STABLE-SLOW",
    });
    const t1 = await p1;
    expect(t1.appendSystemContext).toBe(winner); // frozen bytes win, no overwrite
    expect(t1.stableContextCacheHit).toBe(true);
    expect(t1.prependContext).toBeUndefined();

    // Every later turn keeps returning the winner's bytes.
    mockRecall.mockResolvedValueOnce({ appendSystemContext: "STABLE-LATER" });
    const t3 = await core.handleBeforeRecall("q3", S);
    expect(t3.appendSystemContext).toBe(winner);
    expect(t3.stableContextCacheHit).toBe(true);
  });

  it("ephemeral + session-frozen: first completed resolve freezes; the late candidate is drift", async () => {
    const core = makeCore(); // defaults

    const slow = deferred<Awaited<ReturnType<typeof performAutoRecall>>>();
    const fast = deferred<Awaited<ReturnType<typeof performAutoRecall>>>();
    mockRecall
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(() => fast.promise);

    const p1 = core.handleBeforeRecall("q1", S);
    const p2 = core.handleBeforeRecall("q1-concurrent", S);

    fast.resolve({ appendSystemContext: "STABLE-FAST" });
    const t2 = await p2;
    expect(t2.appendSystemContext).toBe("STABLE-FAST");
    expect(t2.stableContextCacheHit).toBe(false);

    slow.resolve({
      prependContext: "<relevant-memories>\n- [episodic] slow\n</relevant-memories>",
      appendSystemContext: "STABLE-SLOW",
    });
    const t1 = await p1;
    expect(t1.appendSystemContext).toBe("STABLE-FAST"); // frozen bytes win
    expect(t1.stableContextCacheHit).toBe(true);
    expect(t1.prependContext).toContain("slow"); // dynamic part stays per-turn

    mockRecall.mockResolvedValueOnce({ appendSystemContext: "STABLE-LATER" });
    const t3 = await core.handleBeforeRecall("q3", S);
    expect(t3.appendSystemContext).toBe("STABLE-FAST");
  });
});

describe("TdaiCore.destroy — stable-context cleanup", () => {
  it("clears frozen sessions so a rebuilt core starts fresh", async () => {
    const core = makeCore();
    mockRecall.mockResolvedValueOnce({ appendSystemContext: "V1" });
    await core.handleBeforeRecall("q1", S);

    await core.destroy();

    mockRecall.mockResolvedValueOnce({ appendSystemContext: "V2" });
    const t = await core.handleBeforeRecall("q1", S);
    expect(t.appendSystemContext).toBe("V2"); // fresh freeze, not stale V1
    expect(t.stableContextCacheHit).toBe(false);
  });
});
