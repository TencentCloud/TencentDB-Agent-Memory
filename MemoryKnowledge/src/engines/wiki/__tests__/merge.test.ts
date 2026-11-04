import { describe, expect, it } from "vitest";
import { buildPage, parseFrontmatter } from "../ingest-v2/frontmatter.js";
import { isCandidateRedundant, mergePage, unionSources } from "../ingest-v2/merge.js";
import type { LlmClient } from "../ingest-v2/llm.js";

interface RecordedCall {
  system: string;
  prompt: string;
  label: string;
}

function mockLlm(reply: string): { llm: LlmClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const llm = {
    config: {},
    chat: async (params: RecordedCall) => {
      calls.push(params);
      return reply;
    },
  } as unknown as LlmClient;
  return { llm, calls };
}

const oldPage = (body: string, sources = ["a.md"]) =>
  buildPage({ type: "concept", title: "Redis", sources }, body);
const candidatePage = (body: string, sources = ["b.md"]) =>
  buildPage({ type: "concept", title: "Redis", sources }, body);

describe("mergePage", () => {
  it("writes a new page as-is without calling the LLM", async () => {
    const candidate = candidatePage("brand new");
    const { llm, calls } = mockLlm("unused");

    const decision = await mergePage(null, candidate, llm);

    expect(decision).toEqual({ action: "write", content: candidate });
    expect(calls).toHaveLength(0);
  });

  it("skips pages locked by manual edits", async () => {
    // buildPage 永不输出 locked，这里手写 frontmatter 模拟 page/write 的注入。
    const locked = `---\ntype: concept\ntitle: Redis\nlocked: true\n---\n\nmanual\n`;
    const { llm, calls } = mockLlm("unused");

    const decision = await mergePage(locked, candidatePage("new"), llm);

    expect(decision.action).toBe("skip");
    expect(calls).toHaveLength(0);
  });

  it("merges sources without an LLM call when the candidate adds nothing", async () => {
    const { llm, calls } = mockLlm("unused");

    const decision = await mergePage(oldPage("Redis is a store."), candidatePage("  Redis is a store.  "), llm);

    expect(calls).toHaveLength(0);
    expect(decision.action).toBe("write");
    if (decision.action !== "write") return;
    expect(parseFrontmatter(decision.content).frontmatter.sources).toEqual(["a.md", "b.md"]);
  });

  it("rewrites a small page and keeps the union of sources", async () => {
    const merged = buildPage({ type: "concept", title: "Redis" }, "merged body");
    const { llm, calls } = mockLlm(merged);

    const decision = await mergePage(oldPage("old body"), candidatePage("new body"), llm);

    expect(calls).toHaveLength(1);
    expect(calls[0].label).toBe("merge-rewrite");
    expect(decision.action).toBe("write");
    if (decision.action !== "write") return;
    const parsed = parseFrontmatter(decision.content);
    expect(parsed.body.trim()).toBe("merged body");
    expect(parsed.frontmatter.sources).toEqual(["a.md", "b.md"]);
  });

  it("appends only the increment for a large page", async () => {
    const { llm, calls } = mockLlm("new fragment");

    const decision = await mergePage(oldPage("old body"), candidatePage("new material"), llm, {
      fullRewriteMaxChars: 5,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].label).toBe("merge-append");
    expect(decision.action).toBe("write");
    if (decision.action !== "write") return;
    const parsed = parseFrontmatter(decision.content);
    expect(parsed.body).toContain("old body");
    expect(parsed.body).toContain("new fragment");
    expect(parsed.frontmatter.sources).toEqual(["a.md", "b.md"]);
  });
});

describe("merge helpers", () => {
  it("unions and trims sources", () => {
    expect(unionSources(["a.md", " b.md ", "a.md"], ["b.md", "c.md"])).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("detects redundant candidates", () => {
    expect(isCandidateRedundant("abc", "abc")).toBe(true);
    expect(isCandidateRedundant("abc", "  ")).toBe(true);
    expect(isCandidateRedundant("abc", "abd")).toBe(false);
  });
});