/**
 * Issue #120 — prompt-cache stability harness.
 *
 * Drives the REAL plugin register() from index.ts through a FakeOpenClawHost
 * over ≥5 conversation turns with memory injection enabled, and asserts the
 * serialized provider request PREFIX is byte-stable turn-over-turn — the
 * property prefix-matching caches (DeepSeek / MiMo `openai-completions`)
 * depend on.
 *
 * Dynamic L1 memories are supplied by mocking performAutoRecall (no store
 * seeding needed); TdaiCore's freeze cache, index.ts wiring, and the history
 * strip — the actual fix surface — all run for real. Two tests at the bottom
 * run fully UNMOCKED (persona-file-only recall) as end-to-end smoke coverage.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import register from "../index.js";
import { performAutoRecall } from "../src/core/hooks/auto-recall.js";
import { FakeOpenClawHost, lcpLength } from "./helpers/fake-openclaw-host.js";
import type { FakeHostTurnResult } from "./helpers/fake-openclaw-host.js";

// ── performAutoRecall control: mock delegates to the real implementation
//    unless a test arms recallControl.impl (vi.hoisted → visible in factory) ──
const recallControl = vi.hoisted(() => ({
  impl: undefined as undefined | ((params: unknown) => Promise<unknown>),
}));

vi.mock("../src/core/hooks/auto-recall.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/hooks/auto-recall.js")>();
  return {
    ...actual,
    performAutoRecall: vi.fn((params: unknown) =>
      recallControl.impl
        ? recallControl.impl(params)
        : (actual.performAutoRecall as (p: unknown) => Promise<unknown>)(params),
    ),
  };
});

const mockRecall = vi.mocked(performAutoRecall);

const PERSONA = "# Persona\n用户是一名后端工程师，偏好简洁中文回复。";
const STABLE_BLOCK =
  `<user-persona>\n${PERSONA}\n</user-persona>\n\n<memory-tools-guide>fixed guide</memory-tools-guide>`;

let cleanupDirs: string[] = [];
let hosts: FakeOpenClawHost[] = [];
let sessionCounter = 0;

function nextSessionKey(): string {
  return `agent:main:pcache-${process.pid}-${++sessionCounter}`;
}

/** Arm the mock with per-turn dynamic memories + a (possibly drifting) stable block. */
function armDynamicRecall(stableBlock: string | ((turn: number) => string) = STABLE_BLOCK): void {
  let turn = 0;
  recallControl.impl = async () => {
    turn++;
    return {
      prependContext:
        `<relevant-memories>\n以下是当前对话召回的相关记忆：\n\n- [episodic] turn-${turn} 用户提到了部署问题 #${turn}\n</relevant-memories>`,
      appendSystemContext: typeof stableBlock === "function" ? stableBlock(turn) : stableBlock,
      recalledL1Memories: [{ content: `turn-${turn}`, score: 0, type: "episodic" }],
      recallStrategy: "hybrid",
    };
  };
}

async function createHost(opts: {
  recall?: Record<string, unknown>;
  supportsStableInjection?: boolean;
  showInjected?: boolean;
  simulateDynamicTail?: boolean;
  persona?: boolean;
} = {}): Promise<FakeOpenClawHost> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-120-host-"));
  cleanupDirs.push(stateDir);
  const dataDir = path.join(stateDir, "memory-tdai");
  await fs.mkdir(dataDir, { recursive: true });
  if (opts.persona !== false) {
    await fs.writeFile(path.join(dataDir, "persona.md"), PERSONA, "utf-8");
  }

  const host = new FakeOpenClawHost({
    stateDir,
    pluginConfig: {
      capture: { enabled: false },
      extraction: { enabled: false },
      recall: { enabled: true, ...(opts.recall ?? {}) },
      embedding: { provider: "none" },
      bm25: { enabled: false }, // zh BM25 dictionary load is seconds of pure test overhead
      report: { enabled: false },
    },
    supportsStableInjection: opts.supportsStableInjection,
    showInjected: opts.showInjected,
    simulateDynamicTail: opts.simulateDynamicTail,
  });
  register(host.api as never);
  hosts.push(host);
  return host;
}

async function runTurns(
  host: FakeOpenClawHost,
  sessionKey: string,
  count: number,
): Promise<FakeHostTurnResult[]> {
  const results: FakeHostTurnResult[] = [];
  for (let n = 1; n <= count; n++) {
    results.push(await host.runTurn(sessionKey, `用户第 ${n} 轮的问题：请继续任务 ${n}`));
  }
  return results;
}

/** Serialized length of one user message object (divergence-window bound). */
function userMessageJsonLength(content: string): number {
  return JSON.stringify({ role: "user", content }).length;
}

beforeEach(() => {
  recallControl.impl = undefined;
});

afterEach(async () => {
  for (const host of hosts) {
    await host.stop().catch(() => {});
  }
  hosts = [];
  vi.restoreAllMocks();
  await Promise.all(cleanupDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  cleanupDirs = [];
});

// ════════════════════════════════════════════════════════════════════════
// T1 (headline) — serialized prompt PREFIX byte-stable over 6 turns
// ════════════════════════════════════════════════════════════════════════
describe("T1: serialized prompt prefix is byte-stable turn-over-turn (6 turns)", () => {
  it("ephemeral mode (default): system prompt frozen; divergence confined to the previous current-user message", async () => {
    armDynamicRecall();
    const host = await createHost({ supportsStableInjection: true });
    const session = nextSessionKey();
    const results = await runTurns(host, session, 6);

    // (a) System prompt bytes identical on every one of the 6 turns.
    const systems = new Set(results.map((r) => r.system));
    expect(systems.size).toBe(1);

    // (b) Prefix stability: request n may diverge from request n-1 no earlier
    // than the serialization of turn n-1's current user message (whose
    // ephemeral <relevant-memories> block is stripped from history).
    for (let n = 1; n < results.length; n++) {
      const prev = results[n - 1].serialized;
      const curr = results[n].serialized;
      const bound =
        prev.length - userMessageJsonLength(results[n - 1].currentUserContent) - "]}".length;
      expect(lcpLength(prev, curr)).toBeGreaterThanOrEqual(bound);
    }

    // (c) History entries, once committed, never change on later turns.
    for (let n = 1; n < results.length; n++) {
      const prevHistory = results[n - 1].messages.slice(0, -1);
      const currHistoryPrefix = results[n].messages.slice(0, prevHistory.length);
      expect(currHistoryPrefix).toEqual(prevHistory);
    }
  });

  it("session-stable mode: every request is a pure byte-extension of the previous one", async () => {
    armDynamicRecall();
    const host = await createHost({
      recall: { injectionMode: "session-stable" },
      supportsStableInjection: true,
    });
    const session = nextSessionKey();
    const results = await runTurns(host, session, 6);

    // System prompt identical every turn (turn-1 memories folded + frozen).
    expect(new Set(results.map((r) => r.system)).size).toBe(1);

    // No per-turn user-prefix injection at all → perfect prefix extension:
    // serialize(n) shares everything with serialize(n-1) except the closing "]}".
    for (let n = 1; n < results.length; n++) {
      const prev = results[n - 1].serialized;
      const curr = results[n].serialized;
      expect(lcpLength(prev, curr)).toBeGreaterThanOrEqual(prev.length - "]}".length);
      expect(results[n].currentUserContent).not.toContain("<relevant-memories>");
    }

    // Turn-1 memories live in the frozen stable block.
    expect(results[0].system).toContain("turn-1");
    expect(results[0].system).not.toContain("turn-2");
  });
});

// ════════════════════════════════════════════════════════════════════════
// T2/T3 — history bloat: strip ON (default) vs legacy escape hatch
// ════════════════════════════════════════════════════════════════════════
describe("T2: stripInjectedFromHistory=true (default) keeps frozen history clean under showInjected", () => {
  it("committed user entries byte-equal the clean user text; zero injected residue", async () => {
    armDynamicRecall();
    const host = await createHost({ showInjected: true });
    const session = nextSessionKey();
    await runTurns(host, session, 6);

    const userEntries = host.history.filter((m) => m.role === "user");
    expect(userEntries).toHaveLength(6);
    userEntries.forEach((m, i) => {
      expect(m.content).toBe(`用户第 ${i + 1} 轮的问题：请继续任务 ${i + 1}`);
    });
    expect(JSON.stringify(host.history)).not.toContain("<relevant-memories>");
  });
});

describe("T3: stripInjectedFromHistory=false reproduces the legacy bloat (regression documentation)", () => {
  it("history freezes the injected blocks and grows by their size; warning logged", async () => {
    armDynamicRecall();
    const host = await createHost({
      recall: { stripInjectedFromHistory: false },
      showInjected: true,
    });
    expect(host.handlerCount("before_message_write")).toBe(0);
    expect(host.logs.warn.some((w) => w.includes("stripInjectedFromHistory=false"))).toBe(true);

    const session = nextSessionKey();
    await runTurns(host, session, 6);

    const userEntries = host.history.filter((m) => m.role === "user");
    expect(userEntries).toHaveLength(6);
    let bloat = 0;
    userEntries.forEach((m, i) => {
      const clean = `用户第 ${i + 1} 轮的问题：请继续任务 ${i + 1}`;
      expect(m.content).toContain("<relevant-memories>");
      expect(m.content).toContain(`turn-${i + 1}`);
      expect(m.content.endsWith(clean)).toBe(true);
      bloat += m.content.length - clean.length;
    });
    // Every turn permanently added its injected block to history (~issue's
    // 500–1700 tokens/turn context inflation mechanism).
    expect(bloat).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// T4 — session-level dedup / persona-drift immunity
// ════════════════════════════════════════════════════════════════════════
describe("T4: stable block dedup — drifting candidates never reach the provider", () => {
  it("mid-session stable-block drift is absorbed (injector args byte-identical all 6 turns)", async () => {
    // Candidate drifts every turn (simulates L2/L3 rewriting persona/scene).
    armDynamicRecall((turn) => `${STABLE_BLOCK}\n<!-- rewrite-${turn} -->`);
    const host = await createHost({ supportsStableInjection: true });
    const session = nextSessionKey();
    const results = await runTurns(host, session, 6);

    expect(host.stableAdditionCalls).toHaveLength(6); // called every turn (replace model)
    expect(new Set(host.stableAdditionCalls).size).toBe(1); // …with identical bytes
    expect(host.stableAdditionCalls[0]).toContain("rewrite-1"); // turn-1 freeze won
    expect(new Set(results.map((r) => r.system)).size).toBe(1);
  });

  it("stableContextPolicy=latest restores the legacy per-turn recompose (bytes drift)", async () => {
    armDynamicRecall((turn) => `${STABLE_BLOCK}\n<!-- rewrite-${turn} -->`);
    const host = await createHost({
      recall: { stableContextPolicy: "latest" },
      supportsStableInjection: true,
    });
    const session = nextSessionKey();
    await runTurns(host, session, 6);

    expect(new Set(host.stableAdditionCalls).size).toBe(6); // every turn different — legacy verified
  });
});

// ════════════════════════════════════════════════════════════════════════
// T5 — stable placement via host API: position, fallback, double-injection
// ════════════════════════════════════════════════════════════════════════
describe("T5: systemInjection placement paths", () => {
  it("auto + host API: stable block lands AHEAD of the dynamic tail, exactly once", async () => {
    armDynamicRecall();
    const host = await createHost({ supportsStableInjection: true, simulateDynamicTail: true });
    const session = nextSessionKey();
    const [r1] = await runTurns(host, session, 2);

    const stableIdx = r1.system.indexOf("<user-persona>");
    const dynamicIdx = r1.system.indexOf("<runtime-info");
    const boundaryIdx = r1.system.indexOf("<CACHE_BOUNDARY/>");
    expect(stableIdx).toBeGreaterThan(boundaryIdx);
    expect(stableIdx).toBeLessThan(dynamicIdx); // cache-stable position
    // No double injection: hook result must omit appendSystemContext.
    expect(r1.system.match(/<user-persona>/g)).toHaveLength(1);
    // Once-per-session info log, debug afterwards.
    const infoLogs = host.logs.info.filter((l) => l.includes("cache-stable placement active"));
    expect(infoLogs).toHaveLength(1);
  });

  it("auto without host API: legacy hook-context fallback (block at the dynamic tail)", async () => {
    armDynamicRecall();
    const host = await createHost({ supportsStableInjection: false, simulateDynamicTail: true });
    const session = nextSessionKey();
    const [r1] = await runTurns(host, session, 1);

    expect(host.stableAdditionCalls).toHaveLength(0);
    const stableIdx = r1.system.indexOf("<user-persona>");
    const dynamicIdx = r1.system.indexOf("<runtime-info");
    expect(stableIdx).toBeGreaterThan(dynamicIdx); // legacy tail placement preserved
    expect(r1.system.match(/<user-persona>/g)).toHaveLength(1);
  });

  it("systemInjection=hook-context forces the legacy path even when the host API exists", async () => {
    armDynamicRecall();
    const host = await createHost({
      recall: { systemInjection: "hook-context" },
      supportsStableInjection: true,
    });
    const session = nextSessionKey();
    const [r1] = await runTurns(host, session, 1);

    expect(host.stableAdditionCalls).toHaveLength(0); // API present but never called
    expect(r1.system).toContain("<user-persona>");
  });

  it("host API throwing falls back to hook context the same turn (warn, no lost block)", async () => {
    armDynamicRecall();
    const host = await createHost({ supportsStableInjection: true });
    (host.api as Record<string, unknown>).prependSystemPromptAdditionAfterCacheBoundary = () => {
      throw new Error("host exploded");
    };
    const session = nextSessionKey();
    const [r1] = await runTurns(host, session, 1);

    expect(r1.system).toContain("<user-persona>"); // block still delivered
    expect(
      host.logs.warn.some((w) => w.includes("Stable injection failed") && w.includes("falling back")),
    ).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Unmocked end-to-end smoke — real performAutoRecall (persona-file only)
// ════════════════════════════════════════════════════════════════════════
describe("unmocked smoke: real recall path, persona only", () => {
  it("6 turns produce a perfectly extending byte-prefix via the real pipeline", async () => {
    // recallControl.impl stays undefined → real performAutoRecall runs
    // (persona.md exists; no vector store hits; no memories → no prependContext).
    const host = await createHost({ supportsStableInjection: true });
    const session = nextSessionKey();
    const results = await runTurns(host, session, 6);

    expect(new Set(results.map((r) => r.system)).size).toBe(1);
    expect(results[0].system).toContain("<user-persona>");
    expect(results[0].system).toContain("<memory-tools-guide>");
    for (let n = 1; n < results.length; n++) {
      const prev = results[n - 1].serialized;
      expect(lcpLength(prev, results[n].serialized)).toBeGreaterThanOrEqual(
        prev.length - "]}".length,
      );
    }
    expect(mockRecall).toHaveBeenCalledTimes(6);
  });

  it("persona.md rewritten mid-session does not change the system prompt (session-frozen default)", async () => {
    const host = await createHost({ supportsStableInjection: true });
    const session = nextSessionKey();
    const [r1] = await runTurns(host, session, 1);

    // L3 pipeline rewrites the persona mid-session…
    const personaPath = path.join(cleanupDirs[cleanupDirs.length - 1]!, "memory-tdai", "persona.md");
    await fs.writeFile(personaPath, "# Persona\n完全不同的新画像内容。", "utf-8");

    const later = await runTurns(host, session, 5);
    for (const r of later) {
      expect(r.system).toBe(r1.system); // byte-identical despite the rewrite
      expect(r.system).not.toContain("完全不同的新画像内容");
    }
  });
});
