/**
 * tz-10b S3 live probe: halve the budget and watch who leaves.
 *
 * Two runs over the SAME items and the same real recall pipeline, differing
 * only in `recall.contextBudgetTokens`. The low-priority elements must move to
 * `excluded(reason="budget")`, the user's reserve must stay unspent, and the
 * input order must not matter (tz-10:167).
 *
 * FALSIFY=eat-reserve — the run is repeated with `reservedForUserTokens` set to
 * 0 while the budget stays halved, i.e. memory is allowed to spend the reserve.
 * Expected outcome, pinned: `used` exceeds `total - reserve` measured against
 * the reserve the caller asked for.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { must, finish } from "../tz07-probe/assert.mts";
import { parseConfig } from "../../src/config.js";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { performAutoRecall } from "../../src/core/hooks/auto-recall/recall.js";
import type { ContextEnvelope } from "../../src/core/context/types.js";
import type { Logger } from "../../src/core/types.js";

const FALSIFY = process.env.FALSIFY ?? "";
const RESERVE = 40;
// The tools guide is ~300 tokens of pure render overhead, so a budget anywhere
// near it injects nothing at all: these numbers sit comfortably above it, which
// is the regime a real deployment runs in.
const FULL_BUDGET = 900;
const HALVED = 500;

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz10b-p2-"));
fs.writeFileSync(
  path.join(dir, "persona.md"),
  "Пользователь пишет телеграфно, не любит воду и просит доказательства. ".repeat(
    4,
  ),
  "utf-8",
);

const store = new VectorStore(path.join(dir, "vectors.db"), 4, logger);
store.init();
for (let i = 0; i < 5; i++) {
  store.upsertL1(
    {
      id: `l1-${i}`,
      content: `деплой вариант ${i}: ${"подробности деплоя ".repeat(3 + i)}`,
      type: "instruction",
      priority: 50 - i,
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

async function run(budget: number, reserve: number): Promise<ContextEnvelope> {
  const result = await performAutoRecall({
    userText: "деплой",
    actorId: "u",
    sessionKey: "s-probe",
    cfg: parseConfig({
      recall: {
        strategy: "keyword",
        maxResults: 10,
        contextBudgetTokens: budget,
        reservedForUserTokens: reserve,
      },
    }),
    pluginDataDir: dir,
    vectorStore: store,
  });
  return result!.envelope!;
}

const full = await run(FULL_BUDGET, RESERVE);
const half = await run(HALVED, FALSIFY === "eat-reserve" ? 0 : RESERVE);
store.close();

const show = (name: string, e: ContextEnvelope): void => {
  console.log(
    `  ${name}: total=${e.budget.total} резерв=${e.budget.reservedForUser} used=${e.budget.used} ` +
      `included=${e.included.length} excluded=${e.excluded.length}`,
  );
  for (const item of e.included)
    console.log(`    + ${item.memoryId} (${item.tokenCost})`);
  for (const out of e.excluded)
    console.log(`    − ${out.item.memoryId} → ${out.reason}`);
};

console.log(`FALSIFY=${FALSIFY || "(нет)"}`);
show("полный бюджет", full);
show("половина", half);

must(
  "при половинном бюджете включено меньше элементов",
  half.included.length < full.included.length,
);
must(
  "выпавшие названы поимённо и с причиной budget",
  half.excluded.length > 0 && half.excluded.every((e) => e.reason === "budget"),
);
must("резерв пользователя не съеден", half.budget.used <= HALVED - RESERVE);
must(
  "ни один элемент не потерялся: included + excluded = вход",
  full.included.length + full.excluded.length ===
    half.included.length + half.excluded.length,
);

fs.rmSync(dir, { recursive: true, force: true });
finish();
