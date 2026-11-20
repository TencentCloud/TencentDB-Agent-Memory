/**
 * The scene navigation block is injected into the system prompt at every
 * session start, so it must stay bounded even for legacy index data that was
 * written before the write-side cap existed.
 */

import { describe, expect, it } from "vitest";
import { clampSceneNavigationSummaries, generateSceneNavigation, stripSceneNavigation } from "./scene-navigation.js";
import type { SceneIndexEntry } from "./scene-index.js";
import { SCENE_SUMMARY_LIMITS, measureSceneSummary } from "./scene-summary.js";

const LONG_SUMMARY =
  "用户在后端开发中偏好 Python 异步框架，近期开始接触 Rust 的所有权模型，反复讨论内存安全与零拷贝解析，" +
  "同时明确拒绝了打补丁式的临时方案，坚持彻底解耦；此外还记录了部署环境的若干约束，包括容器镜像体积上限与启动时间要求。";

function entry(overrides: Partial<SceneIndexEntry> = {}): SceneIndexEntry {
  return {
    filename: "backend-arch.md",
    summary: "用户偏好 Python 异步后端。",
    heat: 12,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

function summaryLine(nav: string): string {
  const line = nav.split("\n").find((l) => l.startsWith("Summary: "));
  if (line === undefined) throw new Error("no Summary line in navigation");
  return line;
}

describe("generateSceneNavigation summary governance", () => {
  it("keeps a short summary untouched", () => {
    const nav = generateSceneNavigation([entry()]);
    expect(summaryLine(nav)).toBe("Summary: 用户偏好 Python 异步后端。");
  });

  it("clamps a legacy over-long summary before it reaches the prompt", () => {
    const nav = generateSceneNavigation([entry({ summary: LONG_SUMMARY })]);
    const value = summaryLine(nav).slice("Summary: ".length);
    const m = measureSceneSummary(value);
    expect(m.exceeds).toBe(false);
    expect(m.chars).toBeLessThanOrEqual(SCENE_SUMMARY_LIMITS.maxChars);
    expect(value.endsWith("…")).toBe(true);
  });

  it("preserves the block structure (one Path line per scene)", () => {
    const entries = [
      entry({ filename: "a.md", summary: LONG_SUMMARY, heat: 3 }),
      entry({ filename: "b.md", summary: "短摘要", heat: 99 }),
      entry({ filename: "c.md", summary: "", heat: 0 }),
    ];
    const nav = generateSceneNavigation(entries, "/tmp/data");
    expect(nav.match(/^### Path: /gm)?.length).toBe(3);
    expect(nav).toContain("### Path: /tmp/data/scene_blocks/a.md");
    // Heat ordering is unchanged by the clamp.
    const firstPath = nav.split("\n").find((l) => l.startsWith("### Path: "));
    expect(firstPath).toContain("b.md");
  });

  it("handles an empty summary without crashing", () => {
    const nav = generateSceneNavigation([entry({ summary: "" })]);
    expect(summaryLine(nav)).toBe("Summary: ");
  });

  it("uses COS-style paths without touching the summary logic", () => {
    const nav = generateSceneNavigation([entry({ summary: LONG_SUMMARY })], undefined, true);
    expect(nav).toContain("### Path: scenes/backend-arch.md");
    expect(measureSceneSummary(summaryLine(nav).slice("Summary: ".length)).exceeds).toBe(false);
  });

  it("stays bounded in total for many long scenes", () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      entry({ filename: `s${i}.md`, summary: LONG_SUMMARY }),
    );
    const nav = generateSceneNavigation(entries);
    const summaryChars = nav
      .split("\n")
      .filter((l) => l.startsWith("Summary: "))
      .reduce((acc, l) => acc + Array.from(l).length, 0);
    expect(summaryChars).toBeLessThanOrEqual(15 * (SCENE_SUMMARY_LIMITS.maxChars + "Summary: ".length));
  });
});

describe("stripSceneNavigation after clamping", () => {
  it("round-trips: strip removes the whole navigation block", () => {
    const body = "# 用户画像\n\n正文内容。";
    const nav = generateSceneNavigation([entry({ summary: LONG_SUMMARY })]);
    const persona = `${body}\n\n${nav}\n`;
    expect(stripSceneNavigation(persona).trimEnd()).toBe(body);
  });
});

describe("clampSceneNavigationSummaries", () => {
  const BODY = "# 用户画像\n\n用户在后端团队负责记忆管线，偏好 Python 与 Rust。";

  /**
   * A navigation block as an *older* L2 round left it on disk — built by hand on
   * purpose, because `generateSceneNavigation()` already clamps its input.
   */
  function storedNav(summary: string, eol = "\n"): string {
    return [
      "---",
      "## 🗺️ Scene Navigation (Scene Index)",
      "*以下是当前场景记忆的索引，可根据需要 read 读取详细内容。*",
      "",
      "### Path: scene_blocks/backend-arch.md",
      "**热度**: 12 | **更新**: 2026-02-01T00:00:00.000Z",
      `Summary: ${summary}`,
      "",
      "📌 使用说明：",
      "- Path 是 scene block 的绝对路径",
    ].join(eol);
  }

  it("clamps a legacy summary already stored in persona.md", () => {
    // The stored block predates the cap, so its Summary line is still long:
    // this is the path `POST /v2/core/read` clients inject verbatim.
    const persona = `${BODY}\n\n${storedNav(LONG_SUMMARY)}\n`;
    const out = clampSceneNavigationSummaries(persona);

    const before = summaryLine(persona).slice("Summary: ".length);
    const after = summaryLine(out).slice("Summary: ".length);
    expect(after.length).toBeLessThan(before.length);
    expect(measureSceneSummary(after).exceeds).toBe(false);
    // Structure and body are untouched.
    expect(out.startsWith(BODY)).toBe(true);
    expect(out).toContain("### Path: scene_blocks/backend-arch.md");
    expect(out).toContain("**热度**: 12 | **更新**: 2026-02-01T00:00:00.000Z");
    expect(out).toContain("📌 使用说明：");
  });

  it("is idempotent", () => {
    const persona = `${BODY}\n\n${storedNav(LONG_SUMMARY)}\n`;
    const once = clampSceneNavigationSummaries(persona);
    expect(once).not.toBe(persona);
    expect(clampSceneNavigationSummaries(once)).toBe(once);
  });

  it("returns content without a navigation block unchanged", () => {
    const persona = `# 用户画像\n\nSummary: 正文里也可能出现这个词。`;
    expect(clampSceneNavigationSummaries(persona)).toBe(persona);
  });

  it("never rewrites Summary: lines that appear before the header", () => {
    const persona = `# 用户画像\n\nSummary: ${LONG_SUMMARY}\n\n正文段落。`;
    expect(clampSceneNavigationSummaries(persona)).toBe(persona);
  });

  it("keeps a summary that already fits verbatim", () => {
    const persona = `${BODY}\n\n${storedNav("用户偏好 Python 异步后端。")}\n`;
    expect(clampSceneNavigationSummaries(persona)).toBe(persona);
  });

  it("preserves CRLF line endings", () => {
    const body = BODY.replace(/\n/g, "\r\n");
    const nav = storedNav(LONG_SUMMARY, "\r\n");
    const persona = `${body}\r\n${nav}\r\n`;
    const out = clampSceneNavigationSummaries(persona);

    expect(out).not.toBe(persona);
    expect(out).not.toMatch(/[^\r]\n/);
    const value = summaryLine(out).slice("Summary: ".length);
    expect(measureSceneSummary(value).exceeds).toBe(false);
  });
});
