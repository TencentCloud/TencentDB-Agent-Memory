import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractL1Memories } from "../../src/core/record/l1-extractor.ts";
import { writeMemory } from "../../src/core/record/l1-writer.ts";
import { VectorStore } from "../../src/core/store/sqlite/memory-store.ts";
import { handleAtomicUpdate } from "../../src/gateway/v2-router.ts";

const content = "用户喜欢玩掌机。";
const memory = { content, type: "persona", priority: 50, metadata: {}, source_message_ids: ["msg-1"], scene_name: "游戏" };

async function fixture(t) {
  const baseDir = await mkdtemp(join(tmpdir(), "l1-lang-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const vectorStore = new VectorStore(":memory:", 0);
  vectorStore.init();
  t.after(() => vectorStore.close());
  return { baseDir, vectorStore, sessionKey: "language-demo" };
}

test("L1 extraction persists the language of the stored text in JSONL and SQLite", async (t) => {
  const ctx = await fixture(t);
  const result = await extractL1Memories({
    ...ctx, config: {},
    messages: [{ id: "msg-1", role: "user", content: "I like handheld consoles.", timestamp: Date.now() }],
    options: {
      enableDedup: false, vectorStore: ctx.vectorStore,
      llmRunner: { run: async () => JSON.stringify([{ scene_name: "游戏", memories: [memory] }]) },
    },
  });
  assert.equal(result.storedCount, 1);
  const dir = join(ctx.baseDir, "records");
  const [shard] = await readdir(dir);
  const saved = JSON.parse(await readFile(join(dir, shard), "utf8"));
  assert.equal(saved.content, content);
  assert.equal(saved.metadata.lang, "zh");
  const [row] = await ctx.vectorStore.queryL1Records({ recordIds: [saved.id] });
  assert.equal(row.content, content);
  assert.equal(JSON.parse(row.metadata_json).lang, "zh");
});

test("merge and explicit edits compute the tag from the replacement text", async (t) => {
  const ctx = await fixture(t);
  const merged = await writeMemory({
    ...ctx, memory: { ...memory, type: "episodic", metadata: { activity_start_time: "2026-01-01" } },
    decision: { record_id: "merged", action: "merge", target_ids: [], merged_content: "I prefer handheld games." },
  });
  assert.equal(merged.metadata.lang, "en");
  const response = await handleAtomicUpdate(
    { id: merged.id, content: "携帯ゲームが好きです。" }, { serviceId: "default" }, "test",
    { getStore: () => ctx.vectorStore, getEmbedding: () => undefined },
  );
  assert.equal(response.code, 0);
  const [row] = await ctx.vectorStore.queryL1Records({ recordIds: [merged.id] });
  assert.deepEqual(JSON.parse(row.metadata_json), { activity_start_time: "2026-01-01", lang: "ja" });
});

test("script heuristic handles mixed text, unsupported scripts and non-letter input", async (t) => {
  const ctx = await fixture(t);
  for (const [text, expected] of [
    ["掌机 OLED", "zh"], ["abcd中", "en"], ["한글 메모", "ko"],
    ["Привет", "unknown"], ["🎮 123！", "unknown"],
  ]) {
    const saved = await writeMemory({
      ...ctx, memory: { ...memory, content: text },
      decision: { record_id: "", action: "store", target_ids: [] },
    });
    assert.equal(saved.metadata.lang, expected, text);
    assert.equal(saved.content, text);
  }
});
