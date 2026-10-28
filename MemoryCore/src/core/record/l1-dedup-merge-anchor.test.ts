/**
 * Observability anchor for merge/update dedup decisions (#1874).
 *
 * When the batch conflict judgment decides "merge" or "update", the persisted
 * write is silent today: aggregate decision counters (metrics) count the actions
 * but cannot be traced back to individual decisions during audits. This suite
 * pins the `l1-dedup-merge-decision` INFO anchor emitted by applyDecisions at
 * the successful-write site, so mis-merges become individually traceable.
 *
 * Judgment behavior must not change: the anchor only logs decision metadata
 * (record id / action / target ids / content length) — never content, so PII
 * stays out of logs. The shape assertions below fail if any content field ever
 * leaks into the anchor line.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractL1Memories } from "./l1-extractor.js";
import type { IMemoryStore } from "../store/types.js";
import type { LLMRunner } from "../types.js";

const infoLines: string[] = [];
const logger = {
  info: (m: string) => infoLines.push(m),
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const T = 1_700_000_000_000;
const MESSAGES = [
  { id: "m1", role: "user" as const, content: "User prefers reports written conclusion-first, details after", timestamp: T },
];
// Existing record returned by candidate recall → the LLM judgment points at it.
const TARGET_ROW = {
  record_id: "m_target_old",
  content: "Reports should be conclusion-first",
  type: "instruction",
  priority: 80,
  scene_name: "",
  score: 0.9,
  timestamp_str: "",
  version: 0,
  session_key: "zcode-default",
};

function makeStore() {
  return {
    countL1: async () => 5,
    isFtsAvailable: () => true,
    searchL1Fts: async () => [TARGET_ROW],
    queryL1Records: async () => [{ record_id: TARGET_ROW.record_id, version: 0 }],
    deleteL1Batch: async () => {},
    upsertL1: async () => ({ record_id: "m_new" }),
  } as unknown as IMemoryStore;
}

function responseFor(action: string, newId: string) {
  const item: Record<string, unknown> = { record_id: newId, action, target_ids: ["m_target_old"] };
  if (action === "merge" || action === "update") item.merged_content = "Report format: conclusion-first, details after (evolved)";
  return JSON.stringify([item]);
}

function run(action: string) {
  // The LLM is called twice on this path: ① memory extraction (scenes+memories
  // JSON) → ② conflict judgment (decision array). The extractor assigns the new
  // memory's record_id (m_<ts>_<hex>) before the judgment, so it only shows up
  // in the second call's prompt — the mock captures it dynamically from there
  // (candidate id m_target_old deliberately doesn't match that id format).
  let call = 0;
  const llm = {
    run: async (p: { prompt: string }) => {
      call++;
      if (call === 1) {
        return JSON.stringify([
          { scene_name: "reporting", message_ids: ["m1"], memories: [{ type: "instruction", content: "User prefers reports written conclusion-first, details after", priority: 80 }] },
        ]);
      }
      const idMatch = p.prompt.match(/m_\d+_[a-f0-9]+/);
      return responseFor(action, idMatch ? idMatch[0] : "unknown");
    },
  } as unknown as LLMRunner;
  const baseDir = mkdtempSync(join(tmpdir(), "anchor-merge-"));
  infoLines.length = 0;
  return extractL1Memories({
    messages: MESSAGES,
    sessionKey: "zcode-default",
    sessionId: "sess-anchor",
    baseDir,
    config: {},
    logger,
    options: {
      enableDedup: true,
      promptMode: "chat",
      llmRunner: llm,
      vectorStore: makeStore(),
    },
  }).finally(() => rmSync(baseDir, { recursive: true, force: true }));
}

describe("l1-dedup-merge-decision anchor (#1874, judgment behavior unchanged)", () => {
  it("merge decision persisted → INFO anchor carries action=merge and targets (shape assertion guards against content leakage)", async () => {
    const r = await run("merge");
    expect(r.success).toBe(true);
    const hit = infoLines.find((l) => l.includes("l1-dedup-merge-decision"));
    expect(hit).toBeTruthy();
    // Shape assertion: the anchor may only carry id/action/length fields —
    // any content field leaking in makes this red.
    expect(hit!).toMatch(
      /l1-dedup-merge-decision record=\S+ action=merge targets=\S+ contentLen=\d+ - merge\/update decision persisted \(mis-merge observation anchor\)$/,
    );
    expect(hit).not.toContain("conclusion-first, details after"); // new memory content
    expect(hit).not.toContain("Report format"); // merged_content
    expect(hit).not.toContain("Reports should be"); // target content
  });

  it("update decision persisted → same anchor with action=update", async () => {
    const r = await run("update");
    expect(r.success).toBe(true);
    const hit = infoLines.find((l) => l.includes("l1-dedup-merge-decision"));
    expect(hit).toBeTruthy();
    expect(hit).toContain("action=update");
  });

  it("empty target_ids → anchor logs targets=(none)", async () => {
    let call = 0;
    const llm = {
      run: async (p: { prompt: string }) => {
        call++;
        if (call === 1) {
          return JSON.stringify([
            { scene_name: "reporting", message_ids: ["m1"], memories: [{ type: "instruction", content: "User prefers reports written conclusion-first, details after", priority: 80 }] },
          ]);
        }
        const idMatch = p.prompt.match(/m_\d+_[a-f0-9]+/);
        return JSON.stringify([{ record_id: idMatch ? idMatch[0] : "unknown", action: "merge", target_ids: [], merged_content: "x" }]);
      },
    } as unknown as LLMRunner;
    const baseDir = mkdtempSync(join(tmpdir(), "anchor-merge-empty-"));
    infoLines.length = 0;
    try {
      const r = await extractL1Memories({
        messages: MESSAGES, sessionKey: "zcode-default", sessionId: "sess-anchor-empty", baseDir, config: {}, logger,
        options: { enableDedup: true, promptMode: "chat", llmRunner: llm, vectorStore: makeStore() },
      });
      expect(r.success).toBe(true);
      const hit = infoLines.find((l) => l.includes("l1-dedup-merge-decision"));
      expect(hit).toBeTruthy();
      expect(hit).toContain("targets=(none)");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("store decision → no anchor (volume already covered by extracted/stored counters)", async () => {
    const r = await run("store");
    expect(r.success).toBe(true);
    expect(infoLines.find((l) => l.includes("l1-dedup-merge-decision"))).toBeUndefined();
  });
});
