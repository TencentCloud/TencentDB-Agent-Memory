import { describe, expect, it } from "vitest";
import {
  buildAnalysisPrompt,
  buildGenerateFromAnalysisPrompt,
  buildGeneratePrompt,
  type ExistingPageInfo,
} from "./prompts.js";

const existingPages: ExistingPageInfo[] = [
  { relPath: "wiki/entities/redis.md", title: "Redis", type: "entity", description: "in-memory store" },
  { relPath: "wiki/concepts/cache.md", title: "", type: "concept" },
];
const sourceName = "SOURCE_NAME_MARKER.md";
const sourceText = "SOURCE_TEXT_MARKER";
const catalogLine = "- [entity] wiki/entities/redis.md — Redis（in-memory store）";

describe("wiki ingest prompts: stable catalog precedes per-source content (prefix cache)", () => {
  it("analysis prompt places the existing-pages catalog before the source", () => {
    const p = buildAnalysisPrompt({ sourceName, sourceText, existingPages });
    expect(p.indexOf(catalogLine)).toBeGreaterThanOrEqual(0);
    expect(p.indexOf(catalogLine)).toBeLessThan(p.indexOf(sourceName));
    expect(p.indexOf(catalogLine)).toBeLessThan(p.indexOf(sourceText));
  });

  it("generate-from-analysis prompt places the catalog before the source and analysis", () => {
    const p = buildGenerateFromAnalysisPrompt({ sourceName, sourceText, analysis: "ANALYSIS_MARKER", existingPages });
    expect(p.indexOf(catalogLine)).toBeLessThan(p.indexOf(sourceName));
    expect(p.indexOf(catalogLine)).toBeLessThan(p.indexOf(sourceText));
    expect(p.indexOf(catalogLine)).toBeLessThan(p.indexOf("ANALYSIS_MARKER"));
  });

  it("single-stage prompt renders the same catalog as the two-stage prompts", () => {
    const catalog = existingPages
      .map((p) => `- [${p.type}] ${p.relPath}${p.title ? ` — ${p.title}` : ""}${p.description ? `（${p.description}）` : ""}`)
      .join("\n");
    for (const p of [
      buildAnalysisPrompt({ sourceName, sourceText, existingPages }),
      buildGeneratePrompt({ sourceName, sourceText, existingPages }),
    ]) {
      expect(p).toContain(catalog);
    }
    expect(buildGeneratePrompt({ sourceName, sourceText, existingPages: [] })).toContain(
      "(wiki is empty — this is the first source)",
    );
  });
});
