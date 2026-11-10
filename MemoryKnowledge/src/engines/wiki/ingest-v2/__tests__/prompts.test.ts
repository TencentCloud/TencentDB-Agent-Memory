/**
 * #1612 回归测试：wiki ingest prompt 的"稳定前缀"契约。
 *
 * 背景：每个源的 prompt 都携带一份"全量已有页清单"，而这份清单在一轮 ingest 内
 * 逐字节一致 —— 这正是 provider 的 prefix cache 想要的形状。但清单被排在
 * "每源都不同"的内容之后，导致可命中的公共前缀在几百字符处就断掉（实测 0.002%）。
 *
 * 契约（本测试锁定）：
 *   1) 清单必须是每个 prompt 的**第一块**，排在所有每源内容之前；
 *   2) 三个构造器共用同一个 formatExistingPages()，产出必须逐字节一致；
 *   3) 不同源之间的公共前缀应覆盖整个清单（近似 100%），也就是真的能被缓存命中。
 */
import { describe, expect, it } from "vitest";

import {
  buildAnalysisPrompt,
  buildGenerateFromAnalysisPrompt,
  buildGeneratePrompt,
  type ExistingPageInfo,
} from "../prompts.js";

const CATALOG_HEADER = "## Existing wiki pages";

function makePages(n: number): ExistingPageInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    relPath: `wiki/entities/entity-${i}.md`,
    title: `Entity ${i}`,
    type: "entity",
    description: `Description for entity ${i}`,
  }));
}

/** 取出从清单标题到下一个 `## ` 标题之间的那段文本（即稳定块本身）。 */
function catalogBlock(prompt: string): string {
  const start = prompt.indexOf(CATALOG_HEADER);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = prompt.slice(start);
  const next = rest.indexOf("\n## ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

/** 两个 prompt 的最长公共前缀长度 —— 即 prefix cache 能命中的区间。 */
function sharedPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

const pages = makePages(300);
const analysis = "1. Source Summary: ...\n2. Entities: ...";
const sourceA = { sourceName: "README.zh.md", sourceText: "A".repeat(2000) };
const sourceB = { sourceName: "guides/setup.md", sourceText: "B".repeat(2000) };

const builders = [
  {
    name: "buildAnalysisPrompt",
    call: (s: { sourceName: string; sourceText: string }) =>
      buildAnalysisPrompt({ ...s, existingPages: pages }),
  },
  {
    name: "buildGenerateFromAnalysisPrompt",
    call: (s: { sourceName: string; sourceText: string }) =>
      buildGenerateFromAnalysisPrompt({ ...s, analysis, existingPages: pages }),
  },
  {
    name: "buildGeneratePrompt",
    call: (s: { sourceName: string; sourceText: string }) =>
      buildGeneratePrompt({ ...s, existingPages: pages }),
  },
];

describe("wiki ingest prompts: stable catalog must be a cacheable prefix", () => {
  it.each(builders)("$name puts the catalog before any per-source content", ({ call }) => {
    const prompt = call(sourceA);

    expect(prompt.startsWith(CATALOG_HEADER)).toBe(true);
    // 每源不同的内容（源名 / 源全文 / 分析结果）全都在清单之后
    expect(prompt.indexOf(sourceA.sourceName)).toBeGreaterThan(prompt.indexOf(CATALOG_HEADER));
    expect(prompt.indexOf(sourceA.sourceText)).toBeGreaterThan(prompt.indexOf(CATALOG_HEADER));
    if (prompt.includes(analysis)) {
      expect(prompt.indexOf(analysis)).toBeGreaterThan(prompt.indexOf(CATALOG_HEADER));
    }
  });

  it.each(builders)("$name shares one catalog implementation (byte-identical)", ({ call }) => {
    const a = catalogBlock(call(sourceA));
    const b = catalogBlock(call(sourceB));

    expect(a).toBe(b);
    expect(a).toContain(pages[0].relPath);
    expect(a).toContain(pages[pages.length - 1].relPath);
  });

  it.each(builders)("$name keeps the catalog as a real cacheable prefix", ({ call }) => {
    const a = call(sourceA);
    const b = call(sourceB);
    const catalogLen = catalogBlock(a).trimEnd().length;

    // 不同源之间，公共前缀应当覆盖整个清单（允许尾部的换行差异）
    expect(sharedPrefix(a, b)).toBeGreaterThanOrEqual(catalogLen);
  });

  it("keeps the per-source update section after the catalog", () => {
    const prompt = buildGeneratePrompt({
      ...sourceA,
      existingPages: pages,
      pagesToUpdate: [{ relPath: "wiki/entities/entity-7.md", content: "old body" }],
    });

    expect(prompt.indexOf(CATALOG_HEADER)).toBeLessThan(prompt.indexOf("## Pages to Update"));
    expect(prompt.indexOf("## Pages to Update")).toBeLessThan(prompt.indexOf(sourceA.sourceText));
    expect(prompt).toContain("old body");
  });

  it("still renders the empty-wiki placeholder in every builder", () => {
    const empty: ExistingPageInfo[] = [];
    const built = [
      buildAnalysisPrompt({ ...sourceA, existingPages: empty }),
      buildGenerateFromAnalysisPrompt({ ...sourceA, analysis, existingPages: empty }),
      buildGeneratePrompt({ ...sourceA, existingPages: empty }),
    ];
    for (const prompt of built) {
      expect(prompt).toContain("(wiki is empty — this is the first source)");
    }
  });
});
