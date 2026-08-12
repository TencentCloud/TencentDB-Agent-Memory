/**
 * tz-10b C10.5 live probe: a broken tokenizer is a diagnostic, not an empty
 * memory.
 *
 * The failure this guards against is the quiet one: counting throws, the item
 * silently costs nothing (or vanishes), and the context comes back looking as
 * if the user simply had no memories. The probe runs the real assembler over a
 * real recall result with a tokenizer that fails on one item.
 *
 * FALSIFY=swallow — the same run with a tokenizer that returns 0 instead of
 * throwing (the "handled" failure that leaves no trace). Expected outcome,
 * pinned: no `tokenize` diagnostic exists, so the breakage is invisible.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { must, finish } from "../tz07-probe/assert.mts";
import { parseConfig } from "../../src/config.js";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { performAutoRecall } from "../../src/core/hooks/auto-recall/recall.js";
import {
  assembleContext,
  DEFAULT_PRECEDENCE,
} from "../../src/core/context/assemble.js";
import { estimateTokens } from "../../src/core/context/tokenizer.js";
import type {
  ContextSegment,
  MemoryItem,
  Tokenizer,
} from "../../src/core/context/types.js";
import type { Logger } from "../../src/core/types.js";

const FALSIFY = process.env.FALSIFY ?? "";
const BROKEN_ID = "l1-1";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz10b-p3-"));
const store = new VectorStore(path.join(dir, "vectors.db"), 4, logger);
store.init();
for (let i = 0; i < 3; i++) {
  store.upsertL1(
    {
      id: `l1-${i}`,
      content: `деплой вариант ${i}: подробности деплоя и раскатки`,
      type: "instruction",
      priority: 50,
      scene_name: "s",
      source_message_ids: [],
      metadata: {},
      timestamps: ["2026-08-13T00:00:00.000Z"],
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
      sessionKey: "probe",
      sessionId: "probe",
      projectId: "",
      scope: "global",
    } as never,
    new Float32Array([1, 0, 0, 0]),
  );
}

const cfg = parseConfig({
  recall: { strategy: "keyword", maxResults: 10 },
});
const recalled = await performAutoRecall({
  userText: "деплой",
  actorId: "u",
  sessionKey: "s-probe",
  cfg,
  pluginDataDir: dir,
  vectorStore: store,
});
store.close();
const items = recalled!.envelope!.included;

/** Counting the broken item's text either throws or (falsified) returns 0. */
const brokenText = items.find((i) => i.memoryId === BROKEN_ID)!.content;
const tokenizer: Tokenizer = {
  id: "broken",
  version: "1",
  count: (text) => {
    if (text !== brokenText) return estimateTokens(text);
    if (FALSIFY === "swallow") return 0;
    throw new Error(`tokenizer refused ${BROKEN_ID}`);
  },
};

const render = (included: MemoryItem[]): ContextSegment[] =>
  included.map((i) => ({
    slot: "prepend" as const,
    itemIds: [i.memoryId],
    text: i.content,
  }));

const envelope = assembleContext({
  items,
  policy: { precedence: DEFAULT_PRECEDENCE, dedup: "exact" },
  budget: { total: 4000, reservedForUser: 0 },
  tokenizer,
  render,
  request: { requestId: "p3", sessionKey: "s-probe", sessionId: "" },
});

console.log(`FALSIFY=${FALSIFY || "(нет)"}`);
console.log(
  `  included=${envelope.included.length} used=${envelope.budget.used} ` +
    `диагностик=${envelope.diagnostics.length}`,
);
for (const d of envelope.diagnostics) {
  console.log(`    [${d.stage}] ${d.code} ${d.itemId ?? ""} ${d.message}`);
}

must(
  "сломанный токенайзер виден в диагностике конверта",
  envelope.diagnostics.some(
    (d) => d.stage === "tokenize" && d.itemId === BROKEN_ID,
  ),
);
must(
  "память не притворилась пустой: элемент остался включённым",
  envelope.included.some((i) => i.memoryId === BROKEN_ID),
);
must(
  "стоимость элемента — воспроизводимое число, а не ноль",
  (envelope.included.find((i) => i.memoryId === BROKEN_ID)?.tokenCost ?? 0) ===
    estimateTokens(brokenText),
);

fs.rmSync(dir, { recursive: true, force: true });
finish();
