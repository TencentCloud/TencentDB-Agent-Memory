/**
 * tz-10a p1 — recall отдаёт элементы с идентичностью и реальным счётом.
 *
 * До пакета `searchMemoriesWithDetails` разбирал СВОЮ ЖЕ отрендеренную строку
 * регуляркой и возвращал `score: 0` без id записи (tz-10 :20). Проба ходит
 * настоящим путём recall над настоящим `VectorStore`: конфиг через
 * `parseConfig`, поиск через `searchMemoriesWithDetails`.
 *
 * FALSIFY=zero-score — восстанавливает дофиксовый разбор строки регуляркой;
 * обе ноги обязаны покраснеть.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../../src/config.js";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { searchMemoriesWithDetails } from "../../src/core/hooks/auto-recall.js";
import type { MemoryRecord } from "../../src/core/record/l1-writer.js";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
const PROJECT = "/repo/own";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz10a-p1-"));
const store = new VectorStore(path.join(dir, "vectors.db"), 8);
await store.init();

function record(id: string, content: string): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "s",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-08-12T00:00:00.000Z"],
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    sessionKey: "probe",
    sessionId: "probe",
    projectId: PROJECT,
    scope: "project",
  } as MemoryRecord;
}

const VEC = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
await store.upsertL1(record("rec-alpha", "инструкция по деплою альфа"), VEC);
await store.upsertL1(record("rec-beta", "инструкция по деплою бета"), VEC);

const cfg = parseConfig({
  recall: { strategy: "keyword", maxResults: 5, scoreThreshold: 0 },
});
const result = await searchMemoriesWithDetails(
  "деплою",
  dir,
  cfg,
  undefined,
  "keyword",
  store,
  undefined,
  PROJECT,
);

/** Дофиксовый путь: элементы восстанавливаются из уже отрендеренной строки. */
function legacyMemories(
  lines: string[],
): Array<{ content: string; score: number }> {
  return lines.map((line) => {
    const match = line.match(
      /^-\s+\[([^\]]+)\]\s+(.+?)(?:\s*\(活动时间:.*\))?$/,
    );
    return match
      ? { content: match[2]!.trim(), score: 0 }
      : { content: line, score: 0 };
  });
}

/**
 * Дофиксовая форма элемента: id нет, счёт ноль, а неизвестный владелец
 * подменён на «global» — ровно то, что запрещает C10.7.
 */
function legacyItems(lines: string[]): typeof result.items {
  return legacyMemories(lines).map(
    (m) =>
      ({
        schemaVersion: 1,
        memoryId: "",
        kind: "l1",
        content: m.content,
        formatable: { type: "unknown", content: m.content },
        scope: { userId: "global", projectId: PROJECT, scope: "project" },
        provenance: {
          sourceIds: [],
          producer: "legacy-regex",
          createdAt: "",
          updatedAt: "",
          status: "native",
        },
        score: { raw: 0, final: 0, reasons: [] },
      }) as (typeof result.items)[number],
  );
}

const falsified = FALSIFY === "zero-score";
const memories = falsified ? legacyMemories(result.lines) : result.memories;
const items = falsified ? legacyItems(result.lines) : result.items;

console.log(`строк: ${result.lines.length}, элементов: ${items.length}`);
for (const i of items) {
  console.log(
    `  id=${i.memoryId} scope=${i.scope.scope}/${i.scope.projectId} raw=${i.score.raw.toExponential(3)} final=${i.score.final.toExponential(3)} reasons=${i.score.reasons.join("|")} status=${i.provenance.status} userId=${i.scope.userId}`,
  );
}
console.log(`  первая строка: ${result.lines[0]}`);

must(
  "каждый элемент несёт id записи из стора",
  items.length === 2 && items.every((i) => i.memoryId.startsWith("rec-")),
);
must(
  "счёт у отданных памятей — реальный, а не ноль",
  memories.length > 0 && memories.every((m) => m.score > 0),
);
must(
  "строка — проекция элемента: содержимое элемента лежит в своей строке",
  items.every((i, n) => result.lines[n]!.includes(i.content)),
);
must(
  "проекция pre-tz-05: владелец и источники неизвестны, а не подменены",
  items.every(
    (i) =>
      i.scope.userId === null &&
      i.provenance.sourceIds.length === 0 &&
      i.provenance.status === "unknown" &&
      i.schemaVersion === 1,
  ),
);

store.close();
fs.rmSync(dir, { recursive: true, force: true });
finish();
