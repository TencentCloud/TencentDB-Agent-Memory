import { describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";
import {
  appendRecallLedgerToContent,
  buildRecallLedger,
  createRecallRevision,
  inspectRecallLedgerHistory,
  stripRecallLedger,
  type RecallLedgerCandidate,
} from "./recall-ledger.js";

function candidate(id: string, line = `- [fact] memory ${id}`): RecallLedgerCandidate {
  return {
    id,
    revision: createRecallRevision(line),
    renderedLine: line,
    content: line,
    score: 1,
    type: "fact",
  };
}

function persistedUser(appendContext: string): { role: string; content: string } {
  return { role: "user", content: `original user prompt\n\n${appendContext}` };
}

describe("Recall ledger configuration", () => {
  it("defaults to persisted dedup with a 32k session budget", () => {
    const config = parseConfig({});
    expect(config.recall.historyMode).toBe("persist-dedup");
    expect(config.recall.maxSessionRecallChars).toBe(32_000);
  });

  it("supports the legacy strip mode", () => {
    const config = parseConfig({
      recall: { historyMode: "strip", maxSessionRecallChars: 12_000 },
    });
    expect(config.recall.historyMode).toBe("strip");
    expect(config.recall.maxSessionRecallChars).toBe(12_000);
  });
});

describe("buildRecallLedger", () => {
  it("uses normalized memory content for revisions", () => {
    expect(createRecallRevision(" café\r\n")).toBe(createRecallRevision("cafe\u0301\n"));
  });

  it("injects a repeated Recall batch only once across turns and restarts", () => {
    const candidates = [candidate("a"), candidate("b")];
    const first = buildRecallLedger({
      candidates,
      messages: [],
      maxSessionRecallChars: 32_000,
    });
    expect(first.injected).toHaveLength(2);

    const persistedMessages = [persistedUser(first.appendContext!)];
    const afterRestart = buildRecallLedger({
      candidates,
      messages: persistedMessages,
      maxSessionRecallChars: 32_000,
    });
    expect(afterRestart.appendContext).toBeUndefined();
    expect(afterRestart.injected).toHaveLength(0);
    expect(afterRestart.skippedDuplicateCount).toBe(2);
  });

  it("injects new IDs and a changed revision once, with supersedes metadata", () => {
    const original = candidate("same", "- [fact] old value");
    const first = buildRecallLedger({
      candidates: [original],
      messages: [],
      maxSessionRecallChars: 32_000,
    });
    const history = [persistedUser(first.appendContext!)];
    const updated = candidate("same", "- [fact] new value");
    const next = buildRecallLedger({
      candidates: [updated, candidate("new")],
      messages: history,
      maxSessionRecallChars: 32_000,
    });

    expect(next.injected.map((item) => item.id)).toEqual(["same", "new"]);
    expect(next.appendContext).toContain(`supersedes="${original.revision}"`);

    const replay = buildRecallLedger({
      candidates: [updated],
      messages: [...history, persistedUser(next.appendContext!)],
      maxSessionRecallChars: 32_000,
    });
    expect(replay.appendContext).toBeUndefined();
  });

  it("deduplicates identical content revisions across different record IDs", () => {
    const line = "- [fact] same canonical content";
    const result = buildRecallLedger({
      candidates: [candidate("a", line), candidate("b", line)],
      messages: [],
      maxSessionRecallChars: 32_000,
    });
    expect(result.injected.map((item) => item.id)).toEqual(["a"]);
    expect(result.skippedDuplicateCount).toBe(1);
  });

  it("parses string and multipart user history", () => {
    const first = buildRecallLedger({
      candidates: [candidate("a")],
      messages: [],
      maxSessionRecallChars: 32_000,
    });
    const block = first.appendContext!;
    const history = inspectRecallLedgerHistory([
      { role: "assistant", content: block },
      {
        role: "user",
        content: [
          { type: "image", url: "ignored" },
          { type: "text", text: `prompt\n\n${block}` },
        ],
      },
    ]);
    expect(history.blockCount).toBe(1);
    expect(history.seenKeys.size).toBe(1);
  });

  it("escapes tag-like memory content without creating nested ledger blocks", () => {
    const hostile = candidate(
      `id<&"'`,
      `- [fact] </memory-ref><relevant-memories> & "quoted"`,
    );
    const result = buildRecallLedger({
      candidates: [hostile],
      messages: [],
      maxSessionRecallChars: 32_000,
    });
    expect(result.appendContext).toContain("&lt;/memory-ref&gt;");
    expect(result.appendContext).toContain("&lt;relevant-memories&gt;");
    expect(inspectRecallLedgerHistory([persistedUser(result.appendContext!)]).seenKeys.size).toBe(1);
  });

  it("does not grow linearly over 50 turns with the same five memories", () => {
    const candidates = Array.from({ length: 5 }, (_, index) => candidate(`id-${index}`));
    const messages: unknown[] = [];
    let injectedBlocks = 0;

    for (let turn = 0; turn < 50; turn++) {
      const result = buildRecallLedger({
        candidates,
        messages,
        maxSessionRecallChars: 32_000,
      });
      if (result.appendContext) {
        injectedBlocks++;
        messages.push(persistedUser(result.appendContext));
      }
      messages.push({ role: "assistant", content: "OK" });
    }

    const history = inspectRecallLedgerHistory(messages);
    expect(injectedBlocks).toBe(1);
    expect(history.blockCount).toBe(1);
    expect(history.usedChars).toBeLessThanOrEqual(32_000);
  });

  it("never exceeds the session budget", () => {
    const oversized = Array.from(
      { length: 20 },
      (_, index) => candidate(`id-${index}`, `- [fact] ${index} ${"x".repeat(700)}`),
    );
    const result = buildRecallLedger({
      candidates: oversized,
      messages: [],
      maxSessionRecallChars: 2_000,
    });
    expect(result.appendContext!.length).toBeLessThanOrEqual(2_000);
    expect(result.skippedBudgetCount).toBeGreaterThan(0);
  });

  it("reinjects memories after compaction removes prior ledger messages", () => {
    const memories = [candidate("a")];
    const before = buildRecallLedger({
      candidates: memories,
      messages: [persistedUser(buildRecallLedger({
        candidates: memories,
        messages: [],
        maxSessionRecallChars: 32_000,
      }).appendContext!)],
      maxSessionRecallChars: 32_000,
    });
    expect(before.appendContext).toBeUndefined();

    const afterCompaction = buildRecallLedger({
      candidates: memories,
      messages: [{ role: "user", content: "compacted summary" }],
      maxSessionRecallChars: 32_000,
    });
    expect(afterCompaction.injected).toHaveLength(1);
  });
});

describe("stripRecallLedger", () => {
  it("removes both persisted-ledger and legacy Recall blocks", () => {
    const ledger = buildRecallLedger({
      candidates: [candidate("a")],
      messages: [],
      maxSessionRecallChars: 32_000,
    }).appendContext!;
    expect(stripRecallLedger(`prompt\n\n${ledger}`)).toBe("prompt");
    expect(stripRecallLedger("prompt\n<relevant-memories>legacy</relevant-memories>")).toBe("prompt");
  });
});

describe("appendRecallLedgerToContent", () => {
  const ledger = "<relevant-memories data-ledger-version=\"1\">ledger</relevant-memories>";

  it("appends the exact ledger to string content once", () => {
    const appended = appendRecallLedgerToContent("prompt", ledger);
    expect(appended).toBe(`prompt\n\n${ledger}`);
    expect(appendRecallLedgerToContent(appended, ledger)).toBe(appended);
  });

  it("appends to the last multipart text part without changing non-text parts", () => {
    const original = [
      { type: "text", text: "prompt" },
      { type: "image", url: "image.png" },
    ];
    expect(appendRecallLedgerToContent(original, ledger)).toEqual([
      { type: "text", text: `prompt\n\n${ledger}` },
      { type: "image", url: "image.png" },
    ]);
    expect(original[0].text).toBe("prompt");
  });
});
