import { describe, expect, it, vi } from "vitest";
import { buildPage, parseFrontmatter } from "./frontmatter.js";
import type { LlmClient } from "./llm.js";
import { mergePage } from "./merge.js";

const existing = buildPage(
  { type: "concept", title: "Backups", sources: ["old.md"], tags: ["operations"] },
  "Keep an offline backup. Verify restores monthly. [[restore-guide]]",
);
const candidate = buildPage(
  { type: "concept", title: "Backups", sources: ["new.md"] },
  "Encrypt backup archives.",
);

function client(output: string): LlmClient {
  return {
    config: {
      protocol: "openai", baseUrl: "https://example.invalid/v1", apiKey: "fixture",
      model: "fixture", maxTokens: 8192, timeoutMs: 1000, stream: false,
    },
    chat: vi.fn().mockResolvedValue(output),
  };
}

describe("mergePage", () => {
  it.each([
    ["empty response", ""],
    ["whitespace response", " \n\t"],
    ["missing frontmatter", "I could not merge these pages."],
    ["malformed YAML", "---\ntype: [\n---\nIncomplete merge"],
    ["scalar frontmatter", "---\njust a string\n---\nIncomplete merge"],
    ["frontmatter without a body", "---\ntype: concept\ntitle: Backups\n---\n \t"],
  ])("rejects %s instead of replacing the existing page", async (_label, output) => {
    const llm = client(output);
    await expect(mergePage(existing, candidate, llm)).rejects.toThrow(
      "Wiki page merge returned an empty or invalid page",
    );
    expect(llm.chat).toHaveBeenCalledOnce();
  });

  it("accepts a valid rewrite and reconciles the original source union", async () => {
    const output = buildPage(
      { type: "concept", title: "Backups", sources: ["invented.md"] },
      "Keep an offline backup. Verify restores monthly. [[restore-guide]] Encrypt backup archives.",
    );
    const decision = await mergePage(existing, candidate, client(output));
    expect(decision.action).toBe("write");
    if (decision.action !== "write") throw new Error("Expected a rewrite");
    const parsed = parseFrontmatter(decision.content);
    expect(parsed.body).toBe(parseFrontmatter(output).body);
    expect(parsed.frontmatter.sources).toEqual(["old.md", "new.md"]);
  });

  it("writes a new page without requesting a merge", async () => {
    const llm = client("");
    await expect(mergePage(null, candidate, llm)).resolves.toEqual({ action: "write", content: candidate });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("keeps locked pages out of the rewrite path", async () => {
    const llm = client("");
    const locked = existing.replace("type: concept", "type: concept\nlocked: true");
    expect((await mergePage(locked, candidate, llm)).action).toBe("skip");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("retains redundant content without requesting a merge", async () => {
    const llm = client("");
    const redundant = buildPage({ type: "concept", sources: ["new.md"] }, "Keep an offline backup.");
    const decision = await mergePage(existing, redundant, llm);
    if (decision.action !== "write") throw new Error("Expected a source update");
    expect(parseFrontmatter(decision.content).body).toBe(parseFrontmatter(existing).body);
    expect(parseFrontmatter(decision.content).frontmatter.sources).toEqual(["old.md", "new.md"]);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("continues to allow an empty incremental response in append mode", async () => {
    const llm = client("");
    const decision = await mergePage(existing, candidate, llm, { fullRewriteMaxChars: 1 });
    if (decision.action !== "write") throw new Error("Expected a source update");
    expect(parseFrontmatter(decision.content).body).toBe(parseFrontmatter(existing).body);
    expect(parseFrontmatter(decision.content).frontmatter.sources).toEqual(["old.md", "new.md"]);
    expect(llm.chat).toHaveBeenCalledWith(expect.objectContaining({ label: "merge-append" }));
  });
});
