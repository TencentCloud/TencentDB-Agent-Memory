// Deterministic enforcement of the scene-block character budget (#1543).
//
// The ≤1500-char guidance used to live only in extraction prompt text — advisory
// by construction. These tests pin the hard cap that now runs at the write path
// (scene-extractor Phase 5): META headers are structural and never trimmed,
// over-budget size is reclaimed from the body, and enforcement is idempotent.
import { describe, expect, it } from "vitest";
import { enforceSceneBlockBudget, SCENE_BLOCK_CHAR_BUDGET, formatSceneBlock } from "./scene-format.js";

const META = `-----META-START-----
created: 2026-09-01
updated: 2026-10-01
summary: 场景摘要
heat: 3
-----META-END-----
`;

describe("enforceSceneBlockBudget (#1543)", () => {
  it("over-budget block with META header: META preserved, body trimmed, marker appended, total within budget", () => {
    const raw = META + "正文行\n".repeat(600); // ~2400 chars
    expect(raw.length).toBeGreaterThan(SCENE_BLOCK_CHAR_BUDGET);

    const { content, trimmed } = enforceSceneBlockBudget(raw);

    expect(trimmed).toBe(true);
    expect(content).toContain("-----META-END-----"); // structural header intact
    expect(content).toContain("正文行"); // keeps leading body
    expect(content).toContain("trimmed"); // marker present
    expect(content.length).toBeLessThanOrEqual(Math.max(SCENE_BLOCK_CHAR_BUDGET, META.length + 200 + 40));
  });

  it("over-budget block without META: truncated from the top with marker", () => {
    const raw = "无META正文".repeat(400); // ~2000 chars
    const { content, trimmed } = enforceSceneBlockBudget(raw);
    expect(trimmed).toBe(true);
    expect(content).toContain("trimmed");
    expect(content.length).toBeLessThanOrEqual(SCENE_BLOCK_CHAR_BUDGET);
  });

  it("conforming block returned unchanged (trimmed=false)", () => {
    const raw = META + "合规正文\n";
    const { content, trimmed } = enforceSceneBlockBudget(raw);
    expect(trimmed).toBe(false);
    expect(content).toBe(raw);
  });

  it("idempotent: enforcing an already-enforced block is a no-op", () => {
    const raw = META + "正文行\n".repeat(600);
    const first = enforceSceneBlockBudget(raw);
    const second = enforceSceneBlockBudget(first.content);
    expect(second.trimmed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it("extremely large META header: body keeps the 200-char floor, header never truncated", () => {
    const bigMeta = `-----META-START-----
created: 2026-09-01
summary: ${"超长摘要".repeat(400)}
-----META-END-----
`; // META alone exceeds the budget
    const raw = bigMeta + "正文".repeat(100);
    const { content, trimmed } = enforceSceneBlockBudget(raw);
    expect(trimmed).toBe(true);
    expect(content.startsWith(bigMeta.slice(0, 30))).toBe(true);
    expect(content).toContain("-----META-END-----");
  });

  it("budget constant matches the prompt guidance value (single source of truth)", () => {
    expect(SCENE_BLOCK_CHAR_BUDGET).toBe(1500);
  });

  it("formatSceneBlock output of a conforming block round-trips without trimming", () => {
    const raw = formatSceneBlock(
      { created: "2026-09-01", updated: "2026-10-01", summary: "s", heat: 1 },
      "正常正文",
    );
    expect(enforceSceneBlockBudget(raw).trimmed).toBe(false);
  });
});
