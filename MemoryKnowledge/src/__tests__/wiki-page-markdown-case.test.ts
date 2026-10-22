import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cascadeDeleteWikiPagesWithRefs } from "../engines/wiki/ingest-v2/cascade.js";
import { rebuildIndexFile } from "../engines/wiki/ingest-v2/index-builder.js";
import { scanExistingPages } from "../engines/wiki/ingest-v2/index.js";
import { normalizeLlmConfig, type LlmClient } from "../engines/wiki/ingest-v2/llm.js";
import { generateOverview } from "../engines/wiki/ingest-v2/overview.js";
import {
  ensureMarkdownExtension,
  isMarkdownFileName,
  stripMarkdownExtension,
} from "../engines/wiki/ingest-v2/safe-path.js";
import { WikiService } from "../store/wiki-service.js";
import type { IKnowledgeStore } from "../store/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-page-md-case-"));
  tempDirs.push(dir);
  return dir;
}

function createService() {
  const dataRoot = tempProject();
  const store = {
    getWiki: () => ({ status: "ready" }),
  } as unknown as IKnowledgeStore;
  const service = new WikiService({
    store,
    dataRoot,
    worker: async () => {},
  });
  return { dataRoot, service };
}

function writePage(projectPath: string, relPath: string, title: string, type = "concept") {
  const fullPath = join(projectPath, "wiki", relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, `---\ntype: ${type}\ntitle: ${title}\n---\nBody for ${title}`, "utf-8");
}

describe("Wiki page Markdown extension handling", () => {
  it("recognizes and extends Markdown names case-insensitively", () => {
    expect(isMarkdownFileName("concepts/Redis.MD")).toBe(true);
    expect(isMarkdownFileName("concepts/Redis.md")).toBe(true);
    expect(isMarkdownFileName("concepts/Redis.markdown")).toBe(false);
    expect(ensureMarkdownExtension("concepts/Redis.MD")).toBe("concepts/Redis.MD");
    expect(ensureMarkdownExtension("concepts/Redis")).toBe("concepts/Redis.md");
    expect(stripMarkdownExtension("concepts/Redis.MD")).toBe("concepts/Redis");
  });

  it("lists manually created uppercase Markdown pages", () => {
    const { dataRoot, service } = createService();
    writePage(join(dataRoot, "svc", "team", "wiki"), "concepts/Manual.MD", "Manual");

    expect(service.pageLs("svc", "team", "wiki")?.map((page) => page.id))
      .toContain("concepts/Manual");
  });

  it("includes uppercase Markdown pages in the ingest catalog and index", () => {
    const projectPath = tempProject();
    writePage(projectPath, "concepts/Alpha.MD", "Alpha");
    writePage(projectPath, "entities/Beta.MD", "Beta", "entity");

    expect(scanExistingPages(projectPath).map((page) => page.relPath)).toEqual(
      expect.arrayContaining(["wiki/concepts/Alpha.MD", "wiki/entities/Beta.MD"]),
    );

    expect(rebuildIndexFile(projectPath)).toBe(2);
    const index = readFileSync(join(projectPath, "wiki", "index.md"), "utf-8");
    expect(index).toContain("Alpha");
    expect(index).toContain("Beta");
  });

  it("includes uppercase Markdown pages in overview generation", async () => {
    const projectPath = tempProject();
    writePage(projectPath, "concepts/Alpha.MD", "Alpha");
    writePage(projectPath, "entities/Beta.MD", "Beta", "entity");
    const chat = vi.fn().mockResolvedValue("Overview body");
    const llm: LlmClient = {
      config: normalizeLlmConfig({}),
      chat,
    };

    await expect(generateOverview(projectPath, llm)).resolves.toBe(true);
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Alpha"),
      }),
    );
    expect(readFileSync(join(projectPath, "wiki", "overview.md"), "utf-8")).toContain("Overview body");
  });

  it("cleans dangling links in uppercase Markdown pages", async () => {
    const projectPath = tempProject();
    writePage(projectPath, "concepts/Alpha.MD", "Alpha");
    writePage(projectPath, "entities/Gone.md", "Gone", "entity");
    const remainingPath = join(projectPath, "wiki", "concepts", "Alpha.MD");
    writeFileSync(
      remainingPath,
      `---\ntype: concept\ntitle: Alpha\n---\nSee [[Gone]].`,
      "utf-8",
    );

    const result = await cascadeDeleteWikiPagesWithRefs(
      projectPath,
      [join(projectPath, "wiki", "entities", "Gone.md")],
    );

    expect(result.rewrittenFiles).toBe(1);
    expect(readFileSync(remainingPath, "utf-8")).toContain("See Gone.");
  });
});
