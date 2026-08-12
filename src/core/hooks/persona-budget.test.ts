/** The persona file grows unbounded and is injected whole — it must be capped. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performAutoRecall, applyRecallBudget } from "./auto-recall.js";
import type { RecallItem } from "./auto-recall.js";
import type { MemoryTdaiConfig } from "../../config.js";

/** The budget works on rendered items; these tests only care about the line. */
function rendered(lines: string[]): Array<{ item: RecallItem; line: string }> {
  return lines.map((line, i) => ({
    item: { memoryId: `m${i}` } as RecallItem,
    line,
  }));
}

function budgetedLines(
  lines: string[],
  recall: MemoryTdaiConfig["recall"],
): string[] {
  return applyRecallBudget(rendered(lines), recall).kept.map((r) => r.line);
}

function cfg(maxPersonaChars: number): MemoryTdaiConfig {
  return {
    recall: {
      enabled: true,
      maxResults: 3,
      maxCharsPerMemory: 500,
      maxTotalRecallChars: 2000,
      maxPersonaChars,
      scoreThreshold: 0.3,
      strategy: "keyword",
      timeoutMs: 5000,
    },
  } as MemoryTdaiConfig;
}

async function recallPersona(
  maxPersonaChars: number,
  personaChars: number,
): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-persona-"));
  fs.writeFileSync(path.join(dir, "persona.md"), "ы".repeat(personaChars));
  const r = await performAutoRecall({
    userText: "",
    actorId: "u",
    sessionKey: "cc-t",
    cfg: cfg(maxPersonaChars),
    pluginDataDir: dir,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return r?.recalledL3Persona ?? "";
}

describe("persona budget", () => {
  it("truncates an oversized persona and marks it", async () => {
    const p = await recallPersona(100, 5000);
    expect(p.length).toBeLessThan(200);
    expect(p).toMatch(/persona truncated/);
  });

  it("leaves a persona under the limit untouched", async () => {
    expect(await recallPersona(100, 50)).toBe("ы".repeat(50));
  });

  it("treats 0 as no limit", async () => {
    expect((await recallPersona(0, 5000)).length).toBe(5000);
  });
});

describe("recall budget", () => {
  const budget = (max: number, total: number) =>
    ({
      maxCharsPerMemory: max,
      maxTotalRecallChars: total,
    }) as MemoryTdaiConfig["recall"];

  it("truncates a single oversized memory line", () => {
    const [line] = budgetedLines(["a".repeat(900)], budget(500, 2000));
    expect(line.length).toBe(500);
    expect(line).toMatch(/已截断/);
  });

  it("keeps the total under budget and drops what no longer fits", () => {
    const out = budgetedLines(
      ["a".repeat(400), "b".repeat(400), "c".repeat(400)],
      budget(500, 850),
    );
    expect(out.join("\n").length).toBeLessThanOrEqual(850);
    expect(out[out.length - 1].length).toBeLessThan(400);
  });

  it("treats 0 as no limit", () => {
    const out = budgetedLines(["a".repeat(900)], budget(0, 0));
    expect(out[0].length).toBe(900);
  });
});
