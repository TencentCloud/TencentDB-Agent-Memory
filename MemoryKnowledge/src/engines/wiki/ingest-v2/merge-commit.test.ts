import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPage, parseFrontmatter } from "./frontmatter.js";
import { commitCandidates } from "./index.js";
import type { LlmClient } from "./llm.js";

const projects: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

describe("commitCandidates merge failure", () => {
  it.each(["", "Merge unavailable.", "---\ntype: concept\n---\n"])(
    "preserves the old file, reports the failed source and commits unrelated pages (response %j)",
    async (output) => {
      const project = mkdtempSync(join(tmpdir(), "wiki-merge-"));
      projects.push(project);
      mkdirSync(join(project, "wiki", "concepts"), { recursive: true });
      const relPath = "wiki/concepts/backups.md";
      const path = join(project, relPath);
      const original = buildPage(
        { type: "concept", title: "Backups", sources: ["old.md"], tags: ["operations"] },
        "Keep an offline backup. Verify restores monthly. [[restore-guide]]",
      );
      const candidate = buildPage(
        { type: "concept", title: "Backups", sources: ["new.md"] },
        "Encrypt backup archives.",
      );
      const unrelatedPath = "wiki/concepts/monitoring.md";
      const unrelated = buildPage(
        { type: "concept", title: "Monitoring", sources: ["monitoring.md"] },
        "Alert when the backup job fails.",
      );
      writeFileSync(path, original);
      const llm: LlmClient = {
        config: {
          protocol: "openai", baseUrl: "https://example.invalid/v1", apiKey: "fixture",
          model: "fixture", maxTokens: 8192, timeoutMs: 1000, stream: false,
        },
        chat: vi.fn().mockResolvedValue(output),
      };

      const result = await commitCandidates(project, [
        { sourceFilename: "new.md", candidates: new Map([[relPath, candidate]]) },
        { sourceFilename: "monitoring.md", candidates: new Map([[unrelatedPath, unrelated]]) },
      ], llm);

      expect(readFileSync(path, "utf8")).toBe(original);
      expect(result.written).toEqual([unrelatedPath]);
      expect(result.mergeErrors).toEqual([{
        relPath, source: "new.md", error: "Error: Wiki page merge returned an empty or invalid page",
      }]);
      expect(readFileSync(join(project, unrelatedPath), "utf8")).toBe(unrelated);
      expect(readFileSync(join(project, "wiki", "log.md"), "utf8")).toContain("**merge-errors**");
      expect(llm.chat).toHaveBeenCalledOnce();

      // A later successful retry must still receive the last known-good page.
      const merged = buildPage(
        { type: "concept", title: "Backups" },
        "Keep an offline backup. Verify restores monthly. [[restore-guide]] Encrypt backup archives.",
      );
      vi.mocked(llm.chat).mockResolvedValueOnce(merged);
      const retry = await commitCandidates(project, [
        { sourceFilename: "new.md", candidates: new Map([[relPath, candidate]]) },
      ], llm);
      expect(retry).toEqual({ written: [relPath], mergeErrors: [] });
      expect(llm.chat).toHaveBeenLastCalledWith(expect.objectContaining({
        label: "merge-rewrite", prompt: expect.stringContaining(original),
      }));
      expect(parseFrontmatter(readFileSync(path, "utf8")).frontmatter.sources).toEqual(["old.md", "new.md"]);
    },
  );
});
