import { describe, it, expect } from "vitest";
import { parseFileBlocks, normalizeWikiPath } from "./file-protocol.js";

/**
 * FILE 块协议解析的回归测试。
 *
 * 背景：模型偶尔会漏写 `<<<END>>>` 闭合标记，而内容本身是完整的。
 * 解析器过去会整篇丢弃（"未闭合的 FILE 块，已丢弃"），
 * 导致一次 ingest 完全失败（"未生成任何合法 wiki 页"）。
 *
 * 修复：新增 allowUnclosedTail —— 仅当调用方确认输出**未被长度截断**时，
 * 允许救回"最后一个 + frontmatter 完整"的未闭合块。
 */

const CLOSED_BLOCK = [
  '<<<FILE path="wiki/sources/redis.md">>>',
  "---",
  "type: source",
  "title: Redis",
  "---",
  "",
  "# Redis",
  "",
  "正文内容。",
  "<<<END>>>",
].join("\n");

const UNCLOSED_BLOCK = [
  '<<<FILE path="wiki/sources/redis.md">>>',
  "---",
  "type: source",
  "title: Redis",
  "---",
  "",
  "# Redis",
  "",
  "正文内容，模型漏写了 END 标记。",
].join("\n");

const UNCLOSED_NO_FRONTMATTER = [
  '<<<FILE path="wiki/sources/redis.md">>>',
  "",
  "# Redis",
  "",
  "正文，但没有 frontmatter。",
].join("\n");

describe("parseFileBlocks — 正常路径", () => {
  it("解析闭合的 FILE 块", () => {
    const r = parseFileBlocks(CLOSED_BLOCK);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].path).toBe("wiki/sources/redis.md");
    expect(r.files[0].content).toContain("# Redis");
    expect(r.warnings).toHaveLength(0);
  });

  it("解析多个闭合的 FILE 块", () => {
    const text = [
      '<<<FILE path="wiki/sources/a.md">>>',
      "---",
      "type: source",
      "---",
      "A",
      "<<<END>>>",
      "",
      '<<<FILE path="wiki/concepts/b.md">>>',
      "---",
      "type: concept",
      "---",
      "B",
      "<<<END>>>",
    ].join("\n");
    const r = parseFileBlocks(text);
    expect(r.files).toHaveLength(2);
    expect(r.files.map((f) => f.path)).toEqual(["wiki/sources/a.md", "wiki/concepts/b.md"]);
  });
});

describe("parseFileBlocks — 未闭合块（旧行为：整篇丢弃）", () => {
  it("默认不开启 salvage 时丢弃未闭合块", () => {
    const r = parseFileBlocks(UNCLOSED_BLOCK);
    expect(r.files).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes("未闭合"))).toBe(true);
  });

  it("显式关闭 salvage 时同样丢弃", () => {
    const r = parseFileBlocks(UNCLOSED_BLOCK, { allowUnclosedTail: false });
    expect(r.files).toHaveLength(0);
  });
});

describe("parseFileBlocks — 未闭合块 salvage（allowUnclosedTail）", () => {
  it("救回最后一个未闭合块（frontmatter 完整）", () => {
    const r = parseFileBlocks(UNCLOSED_BLOCK, { allowUnclosedTail: true });
    expect(r.files).toHaveLength(1);
    expect(r.files[0].path).toBe("wiki/sources/redis.md");
    expect(r.files[0].content).toContain("正文内容，模型漏写了 END 标记。");
    expect(r.warnings.some((w) => w.includes("已补齐 END"))).toBe(true);
  });

  it("frontmatter 不完整时不救回", () => {
    const r = parseFileBlocks(UNCLOSED_NO_FRONTMATTER, { allowUnclosedTail: true });
    expect(r.files).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes("未闭合"))).toBe(true);
  });

  it("未闭合块之后还有 FILE 块时不救回（不是最后一个），后续完整块仍能解析", () => {
    const text = [
      '<<<FILE path="wiki/sources/a.md">>>',
      "---",
      "type: source",
      "---",
      "A 未闭合",
      "",
      '<<<FILE path="wiki/sources/b.md">>>',
      "---",
      "type: source",
      "---",
      "B",
      "<<<END>>>",
    ].join("\n");
    const r = parseFileBlocks(text, { allowUnclosedTail: true });
    // a 块未闭合且不是最后一个 → 丢弃；b 块完整闭合 → 正常解析
    expect(r.files).toHaveLength(1);
    expect(r.files[0].path).toBe("wiki/sources/b.md");
    expect(r.files[0].content).not.toContain("A 未闭合");
    expect(r.warnings.some((w) => w.includes("未闭合"))).toBe(true);
  });

  it("未闭合块不会吞并后续块的内容（旧版会把后一个块吸进来）", () => {
    const text = [
      '<<<FILE path="wiki/sources/a.md">>>',
      "---",
      "type: source",
      "---",
      "A 未闭合",
      "",
      '<<<FILE path="wiki/sources/b.md">>>',
      "---",
      "type: source",
      "---",
      "B",
      "<<<END>>>",
    ].join("\n");
    const r = parseFileBlocks(text);
    for (const f of r.files) {
      expect(f.content).not.toContain("A 未闭合");
      // 关键：内容里不能出现下一个块的开标签（旧版会把后一个块整体吸进来）
      expect(f.content).not.toContain("<<<FILE");
      expect(f.path).toBe("wiki/sources/b.md");
    }
  });

  it("非法 path 的未闭合块不被救回", () => {
    const text = [
      '<<<FILE path="/etc/passwd">>>',
      "---",
      "type: source",
      "---",
      "越界内容",
    ].join("\n");
    const r = parseFileBlocks(text, { allowUnclosedTail: true });
    expect(r.files).toHaveLength(0);
  });

  it("救回时保留 frontmatter 结构", () => {
    const r = parseFileBlocks(UNCLOSED_BLOCK, { allowUnclosedTail: true });
    expect(r.files[0].content.startsWith("---")).toBe(true);
    expect(r.files[0].content).toContain("title: Redis");
    expect(r.files[0].content.endsWith("\n")).toBe(true);
  });
});

describe("normalizeWikiPath", () => {
  it("接受 wiki/ 下的相对路径", () => {
    expect(normalizeWikiPath("wiki/sources/a.md")).toBe("wiki/sources/a.md");
    expect(normalizeWikiPath("./wiki/sources/a.md")).toBe("wiki/sources/a.md");
  });
  it("拒绝绝对路径与穿越", () => {
    expect(normalizeWikiPath("/etc/passwd")).toBeNull();
    expect(normalizeWikiPath("wiki/../../etc/passwd")).toBeNull();
    expect(normalizeWikiPath("other/a.md")).toBeNull();
  });
});
