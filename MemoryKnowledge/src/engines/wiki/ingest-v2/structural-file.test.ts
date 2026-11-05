import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cascadeDeleteWikiPagesWithRefs } from "./cascade.js";
import { extractSource } from "./index.js";
import { normalizeLlmConfig, type LlmClient } from "./llm.js";
import { isStructuralWikiFile } from "./safe-path.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("structural Wiki files", () => {
  it("classifies root-relative variants but not nested pages", () => {
    expect(isStructuralWikiFile("SCHEMA.md")).toBe(true);
    expect(isStructuralWikiFile("wiki\\Schema.MD")).toBe(true);
    expect(isStructuralWikiFile("/wiki/PURPOSE.md")).toBe(true);
    expect(isStructuralWikiFile("nested/SCHEMA.md")).toBe(false);
  });

  it.each(["SCHEMA.md", "Schema.MD", "PURPOSE.md", "INDEX.md", "LOG.md", "OVERVIEW.md"])(
    "rejects case-variant structural path %s",
    async (fileName) => {
      const projectPath = mkdtempSync(join(tmpdir(), "wiki-structural-case-"));
      tempDirs.push(projectPath);
      mkdirSync(join(projectPath, "wiki"), { recursive: true });
      const canonicalSchema = "---\ntype: schema\ntitle: Preserve me\n---\noriginal";
      writeFileSync(join(projectPath, "wiki", "schema.md"), canonicalSchema, "utf-8");
      const sourcePath = join(projectPath, "source.md");
      writeFileSync(sourcePath, "synthetic source", "utf-8");

      const llm: LlmClient = {
        config: normalizeLlmConfig({}),
        chat: vi.fn().mockResolvedValue([
          `<<<FILE path="wiki/${fileName}">>>`,
          "---",
          "type: other",
          "---",
          "replacement",
          "<<<END>>>",
        ].join("\n")),
      };

      await expect(
        extractSource(projectPath, sourcePath, {}, [], { llm, mode: "single-stage" }),
      ).rejects.toThrow(/未生成任何合法 wiki 页/);
      expect(readFileSync(join(projectPath, "wiki", "schema.md"), "utf-8")).toBe(canonicalSchema);
    },
  );

  it("does not rewrite structural files while clearing dangling links", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "wiki-structural-cascade-"));
    tempDirs.push(projectPath);
    const wikiDir = join(projectPath, "wiki");
    const pageDir = join(wikiDir, "entities");
    mkdirSync(pageDir, { recursive: true });
    const schemaContent = "---\ntype: schema\ntitle: Preserve me\n---\nSee [[gone]].";
    const schemaPath = join(wikiDir, "schema.md");
    const deletedPage = join(pageDir, "gone.md");
    writeFileSync(schemaPath, schemaContent, "utf-8");
    writeFileSync(
      deletedPage,
      "---\ntype: entity\ntitle: Gone\n---\nDeleted page",
      "utf-8",
    );

    const result = await cascadeDeleteWikiPagesWithRefs(projectPath, [deletedPage]);

    expect(result.deletedPaths).toEqual([deletedPage]);
    expect(result.rewrittenFiles).toBe(0);
    expect(readFileSync(schemaPath, "utf-8")).toBe(schemaContent);
  });
});
