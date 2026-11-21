/**
 * Regression: the merge coverage check must distinguish "the model rephrased
 * the fact" from "the model stated the fact with a different value".
 *
 * A ratio-based check over character n-grams passes the second case easily:
 * "port 8096" → "port 8095" keeps the sentence grammatical and keeps almost
 * every Chinese bigram intact, so the coverage ratio stays high while the
 * stored fact is now FALSE.
 *
 * Hard-core tokens (ports, versions, dates, paths) are therefore checked
 * separately for verbatim presence.
 */
import { describe, it, expect } from "vitest";
import { evaluateMergeCoverage } from "./l1-merge-coverage.js";

const TARGET_CONTENT =
  "用户在 2026-11-19 确认旧事实：MemoryProxy 端口 8096 保持闲置，不要改动。";

function makeStore(content = TARGET_CONTENT) {
  return {
    queryL1Records: async (opts: { recordIds?: string[] }) =>
      (opts.recordIds ?? []).map((id) => ({ record_id: id, content })),
  };
}

async function check(mergedContent: string, targetContent = TARGET_CONTENT) {
  return evaluateMergeCoverage({
    action: "merge",
    mergedContent,
    targetIds: ["m_tgt_01"],
    newContent: "用户确认 MemoryCore 端口 8420。",
    vectorStore: makeStore(targetContent) as never,
  });
}

describe("merge coverage — legitimate merges are allowed", () => {
  it("allows a merge that carries the target text verbatim", async () => {
    const r = await check(
      "用户在 2026-11-19 确认旧事实：MemoryProxy 端口 8096 保持闲置，不要改动。" +
        "同时新增：MemoryCore 端口 8420。",
    );
    expect(r.safe).toBe(true);
  });

  it("allows a merge that rephrases the target", async () => {
    const r = await check(
      "用户于 2026-11-19 确认旧事实：MemoryProxy 的端口是 8096，保持闲置状态，不要改动。" +
        "同时新增 MemoryCore 端口 8420。",
    );
    expect(r.safe).toBe(true);
  });

  it("allows a merge that changes tense / aspect", async () => {
    const r = await check(
      "用户曾在 2026-11-19 确认过旧事实：MemoryProxy 端口 8096 处于闲置，未作改动。" +
        "现在补充 MemoryCore 端口 8420。",
    );
    expect(r.safe).toBe(true);
  });
});

describe("merge coverage — fact-altering merges are blocked", () => {
  it("blocks a merge that drops the target's fact entirely", async () => {
    const r = await check("用户确认 MemoryCore 端口 8420。");
    expect(r.safe).toBe(false);
    expect(r.uncovered).toContain("m_tgt_01");
  });

  it("blocks a merge that says nothing related to the target", async () => {
    const r = await check("用户喜欢用 Blender 做产品渲染。");
    expect(r.safe).toBe(false);
  });

  it("blocks a merge that flips the meaning of the target", async () => {
    const r = await check("用户确认 MemoryProxy 端口 8096 已经启用了，不再闲置。");
    expect(r.safe).toBe(false);
  });

  it("blocks a merge that changes the port number", async () => {
    // "8096" → "8095": grammatical, same n-grams, but the fact is now false.
    const r = await check(
      "用户在 2026-11-19 确认旧事实：MemoryProxy 端口 8095 保持闲置，不要改动。",
    );
    expect(r.safe).toBe(false);
    expect(r.uncovered).toContain("m_tgt_01");
  });

  it("blocks a merge that drops the port number", async () => {
    const r = await check(
      "用户在 2026-11-19 确认旧事实：MemoryProxy 端口保持闲置，不要改动。",
    );
    expect(r.safe).toBe(false);
  });

  it("blocks a merge that changes the date", async () => {
    const r = await check(
      "用户在 2026-11-18 确认旧事实：MemoryProxy 端口 8096 保持闲置，不要改动。",
    );
    expect(r.safe).toBe(false);
  });
});
