/**
 * Tests for #878 — OffloadContextEngine.assemble()/afterTurn() must resolve
 * their session manager when OpenClaw passes only sessionId (or
 * sessionTarget.sessionKey) without a top-level sessionKey.
 *
 * Previously the fallback guarded on `params.sessionKey`, so on OpenClaw's
 * afterTurn/assemble path (which does not include sessionKey) stateManager was
 * never resolved → assemble returned early → L1.5 never settled → MMD
 * injection / L2 / L3 never ran (#880).
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "./session-registry.js";
import { _testExports } from "./index.js";

const { OffloadContextEngine } = _testExports;

function makeLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
}

/** Build an engine with a real SessionRegistry rooted at a temp dir. */
function makeEngine(opts: { dataRoot?: string; backendClient?: unknown } = {}) {
  const dataRoot = opts.dataRoot ?? mkdtempSync(join(tmpdir(), "offload-878-"));
  const sessions = new SessionRegistry(dataRoot);
  const judged: Array<{ sessionKey: string | undefined }> = [];

  const engine = new OffloadContextEngine({
    sessions,
    logger: makeLogger(),
    pCfg: {},
    getContextWindow: () => 1_000_000,
    notifyL2NewNullEntries: () => {},
    clearL2Timeout: () => {},
    l4State: { pendingResult: null },
    flushL1: async () => {},
    backendClient: opts.backendClient ?? null,
    judgeL15: async (mgr: any, _event: any, ctx: any) => {
      judged.push({ sessionKey: ctx?.sessionKey });
      mgr.l15Settled = true;
      mgr.setMmdInjectionReady?.(true);
    },
    disposeL15: () => {},
  });

  return { engine, sessions, judged, dataRoot };
}

describe("OffloadContextEngine session resolution (#878)", () => {
  it("assemble resolves manager from sessionId when sessionKey is absent", async () => {
    const { engine, judged, dataRoot } = makeEngine({
      backendClient: { compact: async () => null, summarize: async () => null },
    });
    try {
      // Pre-register a session by its real sessionKey so resolution succeeds.
      const sessionKey = "agent:test-agent:878-session-1";
      await engine.bootstrap({ sessionKey, sessionId: "878-session-1" });

      // OpenClaw's afterTurn/assemble path: no top-level sessionKey, only sessionId.
      const res = await engine.assemble({
        sessionId: "878-session-1",
        messages: [{ role: "user", content: "hello" }],
        tokenBudget: 1_000_000,
        prompt: "hello world",
      });

      expect(res).toBeTruthy();
      // L1.5 judgment fired (assemble reached the trigger point).
      expect(judged.length).toBeGreaterThan(0);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("afterTurn resolves manager from sessionId and flushes", async () => {
    const { engine, dataRoot } = makeEngine();
    try {
      const sessionKey = "agent:test-agent:878-session-2";
      await engine.bootstrap({ sessionKey, sessionId: "878-session-2" });

      // No top-level sessionKey — should resolve from sessionId, no throw.
      await expect(
        engine.afterTurn({ sessionId: "878-session-2" }),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("assemble still skips cleanly when no session can be resolved", async () => {
    const { engine, judged, dataRoot } = makeEngine();
    try {
      const res = await engine.assemble({
        // Unknown session — nothing registered, no sessionId, no sessionKey.
        messages: [{ role: "user", content: "hello" }],
        prompt: "hello",
      });
      expect(res.messages).toEqual([{ role: "user", content: "hello" }]);
      expect(judged.length).toBe(0);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
