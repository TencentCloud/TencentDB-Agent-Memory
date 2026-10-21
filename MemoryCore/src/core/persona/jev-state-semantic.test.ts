import { describe, expect, it } from "vitest";
import {
  buildSemanticRewritePrompt,
  compressJevStateSemantically,
  measureJevState,
  normalizeRewrittenBody,
  resolveJevSemanticChunkChars,
  resolveJevSemanticMaxScenes,
  resolveJevSemanticMaxTokens,
  resolveJevSemanticMinRatio,
  resolveJevSemanticTimeoutMs,
  splitSceneBody,
  validateRewrittenBody,
  type SemanticRewriteFn,
} from "./jev-state-semantic.js";
import type { JevStatePayload } from "./jev-state-trim.js";

function makePayload(bodies: Record<string, string>): JevStatePayload {
  return {
    current_persona: "persona body",
    changed_scenes: Object.entries(bodies).map(([filename, content]) => ({
      filename,
      summary: `summary of ${filename}`,
      updated: "2026-10-19T00:00:00.000Z",
      content,
    })),
  };
}

describe("env resolution", () => {
  it("falls back to defaults when unset", () => {
    expect(resolveJevSemanticMaxTokens({} as NodeJS.ProcessEnv)).toBe(16_000);
    expect(resolveJevSemanticChunkChars({} as NodeJS.ProcessEnv)).toBe(3_000);
    expect(resolveJevSemanticTimeoutMs({} as NodeJS.ProcessEnv)).toBe(120_000);
    expect(resolveJevSemanticMinRatio({} as NodeJS.ProcessEnv)).toBe(0.2);
    expect(resolveJevSemanticMaxScenes({} as NodeJS.ProcessEnv)).toBe(4);
  });

  it("reads overrides from env", () => {
    const env = {
      JEV_SEMANTIC_MAX_TOKENS: "8000",
      JEV_SEMANTIC_TIMEOUT_MS: "5000",
      JEV_SEMANTIC_MIN_RATIO: "0.5",
      JEV_SEMANTIC_MAX_SCENES: "2",
    } as NodeJS.ProcessEnv;
    expect(resolveJevSemanticMaxTokens(env)).toBe(8000);
    expect(resolveJevSemanticTimeoutMs(env)).toBe(5000);
    expect(resolveJevSemanticMinRatio(env)).toBe(0.5);
    expect(resolveJevSemanticMaxScenes(env)).toBe(2);
  });

  it("rejects malformed ratios instead of accepting them", () => {
    expect(resolveJevSemanticMinRatio({ JEV_SEMANTIC_MIN_RATIO: "0" } as NodeJS.ProcessEnv)).toBe(0.2);
    expect(resolveJevSemanticMinRatio({ JEV_SEMANTIC_MIN_RATIO: "1" } as NodeJS.ProcessEnv)).toBe(0.2);
    expect(resolveJevSemanticMinRatio({ JEV_SEMANTIC_MIN_RATIO: "abc" } as NodeJS.ProcessEnv)).toBe(0.2);
  });
});

describe("normalizeRewrittenBody", () => {
  it("strips a markdown fence", () => {
    const out = normalizeRewrittenBody("```markdown\n## 章节\n内容。\n```");
    expect(out).toBe("## 章节\n内容。");
  });

  it("drops a prose preamble before the first heading", () => {
    const out = normalizeRewrittenBody("好的，这是压缩后的版本：\n## 章节\n内容。");
    expect(out.startsWith("## 章节")).toBe(true);
  });

  it("keeps a body that starts with a heading untouched", () => {
    const out = normalizeRewrittenBody("## 章节\n内容。");
    expect(out).toBe("## 章节\n内容。");
  });

  it("returns empty for an empty answer", () => {
    expect(normalizeRewrittenBody("   ")).toBe("");
  });
});

describe("validateRewrittenBody", () => {
  const original = "x".repeat(100);

  it("rejects an empty body", () => {
    expect(validateRewrittenBody("", original, 0.2)).toEqual({ ok: false, reason: "empty_output" });
  });

  it("rejects a body that is too small to be a faithful rewrite", () => {
    const out = validateRewrittenBody("短。", original, 0.2);
    expect(out).toEqual({ ok: false, reason: "too_small" });
  });

  it("rejects a body that did not shrink", () => {
    const out = validateRewrittenBody(original, original, 0.2);
    expect(out).toEqual({ ok: false, reason: "not_shrunk" });
  });

  it("rejects a body that looks cut mid-sentence", () => {
    const out = validateRewrittenBody("## 标题\n" + "文字".repeat(20) + "被截断的文字", original, 0.2);
    expect(out).toEqual({ ok: false, reason: "possibly_truncated" });
  });

  it("accepts a plausible rewrite", () => {
    const out = validateRewrittenBody("## 标题\n" + "内容。".repeat(10), original, 0.2);
    expect(out).toEqual({ ok: true });
  });
});

describe("buildSemanticRewritePrompt", () => {
  it("states the constraints and includes the original body", () => {
    const prompt = buildSemanticRewritePrompt("scene.md", "BODY-CONTENT");
    expect(prompt).toContain("scene.md");
    expect(prompt).toContain("BODY-CONTENT");
    expect(prompt).toContain("不要发明原文没有的事实");
    expect(prompt).toContain("只有改写后的正文");
  });
});

describe("splitSceneBody", () => {
  it("keeps a small body as a single chunk", () => {
    expect(splitSceneBody("## 标题\n正文内容。", 3_000)).toEqual(["## 标题\n正文内容。"]);
  });

  it("splits on markdown headings and keeps every heading", () => {
    const body = ["## 甲\n" + "甲".repeat(400), "## 乙\n" + "乙".repeat(400)].join("\n");
    const chunks = splitSceneBody(body, 500);
    expect(chunks.length).toBe(2);
    expect(chunks[0].startsWith("## 甲")).toBe(true);
    expect(chunks[1].startsWith("## 乙")).toBe(true);
  });

  it("cuts an oversized section on blank lines and repeats its heading", () => {
    const para = "内容。".repeat(200);
    const body = `## 长节\n\n${para}\n\n${para}`;
    const chunks = splitSceneBody(body, 600);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(600);
    }
    expect(chunks[0].startsWith("## 长节")).toBe(true);
  });

  it("never returns an empty chunk for an empty body", () => {
    expect(splitSceneBody("   ", 500)).toEqual([]);
  });
});

describe("compressJevStateSemantically", () => {
  // A realistic rewrite keeps roughly half of the original body.
  const rewriteBody = (size: number) => "## 压缩\n" + "内容。".repeat(Math.max(1, Math.floor(size / 3)));

  it("returns the payload untouched when it already fits", async () => {
    const payload = makePayload({ "a.md": "small" });
    const rewrite: SemanticRewriteFn = async () => "never";
    const outcome = await compressJevStateSemantically(payload, 100_000, rewrite);
    expect(outcome.result).not.toBeNull();
    expect(outcome.compressedScenes).toEqual([]);
    expect(outcome.result!.savedChars).toBe(0);
  });

  it("compresses the largest scene and keeps metadata", async () => {
    const payload = makePayload({
      "big.md": "A".repeat(5000),
      "small.md": "B".repeat(100),
    });
    const rewrite: SemanticRewriteFn = async ({ content }) => rewriteBody(content.length / 2);
    const outcome = await compressJevStateSemantically(payload, 3000, rewrite);
    expect(outcome.result).not.toBeNull();
    expect(outcome.compressedScenes).toContain("big.md");
    expect(outcome.result!.finalChars).toBeLessThanOrEqual(3000);
    const parsed = JSON.parse(outcome.result!.state);
    expect(parsed.changed_scenes[0].filename).toBe("big.md");
    expect(parsed.changed_scenes[0].summary).toBe("summary of big.md");
    expect(parsed.changed_scenes[0].updated).toBe("2026-10-19T00:00:00.000Z");
    expect(parsed.current_persona).toBe("persona body");
  });

  it("records a failure and keeps the original scene when the model throws", async () => {
    const payload = makePayload({ "big.md": "A".repeat(5000) });
    const rewrite: SemanticRewriteFn = async () => {
      throw new Error("provider down");
    };
    const outcome = await compressJevStateSemantically(payload, 3000, rewrite);
    expect(outcome.compressedScenes).toEqual([]);
    expect(outcome.skippedScenes).toEqual(["big.md"]);
    expect(outcome.failures[0].reason).toBe("chunk_error:provider down");
    // The scene body is untouched, so the payload still does not fit.
    expect(outcome.result).toBeNull();
  });

  it("rejects an implausible rewrite and keeps the original", async () => {
    const payload = makePayload({ "big.md": "A".repeat(5000) });
    const rewrite: SemanticRewriteFn = async () => "太短";
    const outcome = await compressJevStateSemantically(payload, 3000, rewrite);
    expect(outcome.compressedScenes).toEqual([]);
    expect(outcome.failures[0].reason).toBe("chunk_too_small");
  });

  it("keeps the original text of a chunk the model could not rewrite", async () => {
    // Two chunks: the first one is rewritten, the second one fails. The scene
    // still uses the rewritten first chunk and the original second chunk.
    const body = ["## 甲\n" + "甲".repeat(300), "## 乙\n" + "乙".repeat(300)].join("\n");
    const payload = makePayload({ "big.md": body });
    const rewrite: SemanticRewriteFn = async (input) => {
      if (input.content.includes("乙")) throw new Error("chunk down");
      return "## 甲\n" + "保留。".repeat(50);
    };
    const outcome = await compressJevStateSemantically(payload, 700, rewrite, { chunkChars: 400 });
    expect(outcome.compressedScenes).toEqual(["big.md"]);
    const state = JSON.parse(outcome.result?.state ?? "{}");
    const content = state.changed_scenes?.[0]?.content ?? "";
    expect(content).toContain("保留。");
    expect(content).toContain("乙");
  });

  it("returns a null result when the payload still does not fit", async () => {
    const payload = makePayload({ "big.md": "A".repeat(5000) });
    const rewrite: SemanticRewriteFn = async () => rewriteBody(2500);
    const outcome = await compressJevStateSemantically(payload, 10, rewrite);
    expect(outcome.result).toBeNull();
  });

  it("honours the max-scenes cap", async () => {
    const payload = makePayload({
      "a.md": "A".repeat(5000),
      "b.md": "B".repeat(5000),
      "c.md": "C".repeat(5000),
    });
    let calls = 0;
    const rewrite: SemanticRewriteFn = async ({ content }) => {
      calls += 1;
      return rewriteBody(content.length / 2);
    };
    await compressJevStateSemantically(payload, 3000, rewrite, { maxScenes: 2 });
    expect(calls).toBe(2);
  });

  it("compresses the largest scene first", async () => {
    const payload = makePayload({
      "small.md": "S".repeat(100),
      "huge.md": "H".repeat(9000),
    });
    const seen: string[] = [];
    const rewrite: SemanticRewriteFn = async ({ filename, content }) => {
      seen.push(filename);
      return rewriteBody(content.length / 2);
    };
    await compressJevStateSemantically(payload, 3000, rewrite);
    expect(seen[0]).toBe("huge.md");
  });
});

describe("measureJevState", () => {
  it("matches JSON.stringify length", () => {
    const payload = makePayload({ "a.md": "abc" });
    expect(measureJevState(payload)).toBe(JSON.stringify(payload).length);
  });
});
