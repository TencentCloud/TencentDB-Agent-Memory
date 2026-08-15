import { describe, expect, it } from "vitest";

import {
  buildRecallPromptContext,
  flattenRecallPromptContext,
} from "./auto-recall.js";

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function renderMessages(messages: Array<{ role: string; content: string }>): string {
  return messages.map((message) => `${message.role}:${message.content}\n`).join("");
}

describe("recall prompt cache partitioning", () => {
  it("places stable context before the cache boundary and L1 recall after it", () => {
    const result = buildRecallPromptContext({
      memoryLines: ["- [fact] The user prefers concise TypeScript examples."],
      personaContent: "Prefers concise technical answers.",
      sceneNavigation: "- project: prompt-cache",
    });

    expect(result.prependSystemContext).toContain("<user-persona>");
    expect(result.prependSystemContext).toContain("<scene-navigation>");
    expect(result.prependSystemContext).toContain("<memory-tools-guide>");
    expect(result.prependSystemContext).not.toContain("<relevant-memories>");

    expect(result.appendSystemContext).toContain("<relevant-memories>");
    expect(result.appendSystemContext).not.toContain("<user-persona>");
    expect(result).not.toHaveProperty("prependContext");
  });

  it("flattens both partitions for single-context hosts", () => {
    expect(flattenRecallPromptContext({
      prependSystemContext: "stable",
      appendSystemContext: "dynamic",
      prependContext: "legacy",
    })).toBe("stable\n\ndynamic\n\nlegacy");
  });

  it("keeps repeated recall out of transcript history", () => {
    const turns = 12;
    const memoryLine = `- [fact] ${"cacheable-memory ".repeat(80)}`;
    const recall = buildRecallPromptContext({
      memoryLines: [memoryLine],
    }).appendSystemContext;
    expect(recall).toBeTruthy();

    const legacyHistory: Array<{ role: string; content: string }> = [];
    const optimizedHistory: Array<{ role: string; content: string }> = [];
    for (let turn = 1; turn <= turns; turn += 1) {
      const userText = `question ${turn}`;
      legacyHistory.push({ role: "user", content: `${recall}\n\n${userText}` });
      legacyHistory.push({ role: "assistant", content: `answer ${turn}` });
      optimizedHistory.push({ role: "user", content: userText });
      optimizedHistory.push({ role: "assistant", content: `answer ${turn}` });
    }

    const legacySize = renderMessages(legacyHistory).length;
    const optimizedSize = renderMessages(optimizedHistory).length;
    const injectedGrowth = legacySize - optimizedSize;

    expect(injectedGrowth).toBe(turns * ((recall?.length ?? 0) + 2));
    expect(optimizedSize / legacySize).toBeLessThan(0.1);
  });

  it("preserves the prior request prefix when recall results stay unchanged", () => {
    const memoryLine = `- [fact] ${"stable-topic ".repeat(80)}`;
    const recall = buildRecallPromptContext({
      memoryLines: [memoryLine],
      personaContent: "Stable persona.",
    });
    const baseSystem = "base-system\n";
    const optimizedSystem =
      `${recall.prependSystemContext}\n${baseSystem}${recall.appendSystemContext}`;

    const firstLegacyRequest = renderMessages([
      { role: "system", content: baseSystem },
      { role: "user", content: `${recall.appendSystemContext}\n\nquestion 1` },
    ]);
    const secondLegacyRequest = renderMessages([
      { role: "system", content: baseSystem },
      { role: "user", content: "question 1" },
      { role: "assistant", content: "answer 1" },
      { role: "user", content: `${recall.appendSystemContext}\n\nquestion 2` },
    ]);

    const firstOptimizedRequest = renderMessages([
      { role: "system", content: optimizedSystem },
      { role: "user", content: "question 1" },
    ]);
    const secondOptimizedRequest = renderMessages([
      { role: "system", content: optimizedSystem },
      { role: "user", content: "question 1" },
      { role: "assistant", content: "answer 1" },
      { role: "user", content: "question 2" },
    ]);

    expect(commonPrefixLength(firstOptimizedRequest, secondOptimizedRequest)).toBe(
      firstOptimizedRequest.length,
    );
    expect(commonPrefixLength(firstLegacyRequest, secondLegacyRequest)).toBeLessThan(
      firstLegacyRequest.length / 2,
    );
  });
});
