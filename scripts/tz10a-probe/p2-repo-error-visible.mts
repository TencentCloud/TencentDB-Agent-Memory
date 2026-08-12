/**
 * tz-10a p2 — сломанный стор отличим от пустой памяти.
 *
 * `searchMemories` ловил любую ошибку и возвращал общий пустой результат:
 * «база залочена» и «ничего не нашлось» приходили к вызывающему одинаково
 * (tz-10 C10.5, критерий 5). Проба берёт НАСТОЯЩИЙ `VectorStore`, закрывает
 * его файл на середине и зовёт настоящий путь recall.
 *
 * FALSIFY=swallow — возвращает дофиксовый пустой результат без диагностики:
 * ноги про диагностику обязаны покраснеть.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../../src/config.js";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { performAutoRecall } from "../../src/core/hooks/auto-recall.js";
import { searchMemoriesWithDetails } from "../../src/core/hooks/auto-recall.js";
import type { MemoryRecord } from "../../src/core/record/l1-writer.js";
import type { IMemoryStore } from "../../src/core/store/types.js";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
const PROJECT = "/repo/own";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz10a-p2-"));
const store = new VectorStore(path.join(dir, "vectors.db"), 8);
await store.init();
await store.upsertL1(
  {
    id: "rec-alpha",
    content: "инструкция по деплою альфа",
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
  } as MemoryRecord,
  new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
);

const cfg = parseConfig({
  recall: { strategy: "keyword", maxResults: 5, scoreThreshold: 0 },
});

/**
 * Стор, который уже закрыт: обращение к нему бросает так же, как боевой
 * sqlite при потерянном файле. Оборачиваем настоящий стор, а не мок логики —
 * ломается именно та операция, которую вызывает продукт.
 */
const brokenStore = new Proxy(store, {
  get(target, prop, receiver) {
    if (prop === "searchL1Fts") {
      return () => {
        throw new Error("sqlite: unable to open database file");
      };
    }
    return Reflect.get(target, prop, receiver);
  },
}) as unknown as IMemoryStore;

const search = await searchMemoriesWithDetails(
  "деплою",
  dir,
  cfg,
  undefined,
  "keyword",
  brokenStore,
  undefined,
  PROJECT,
);
const diagnostics =
  FALSIFY === "swallow"
    ? [] // дофиксовое поведение: пустой результат без единого следа
    : search.diagnostics;

// Полный путь recall: результат не должен молчать про поломку.
const recall = await performAutoRecall({
  userText: "деплою",
  actorId: "u",
  sessionKey: "probe",
  cfg,
  pluginDataDir: dir,
  vectorStore: brokenStore,
  projectId: PROJECT,
});
const recallDiagnostics =
  FALSIFY === "swallow" ? [] : (recall?.diagnostics ?? []);

console.log(`строк найдено: ${search.lines.length}`);
console.log(
  `диагностика поиска: ${diagnostics.map((d) => `${d.stage}:${d.code}`).join(", ") || "(пусто)"}`,
);
console.log(`сообщение: ${diagnostics[0]?.message ?? "(нет)"}`);
console.log(
  `диагностика полного recall: ${recallDiagnostics.map((d) => `${d.stage}:${d.code}`).join(", ") || "(пусто)"}`,
);

must(
  "поиск не выдал памяти — как и раньше, пайплайн не заблокирован",
  search.lines.length === 0,
);
must(
  "но отказ стора назван: stage=repo, code=search-failed",
  diagnostics.some((d) => d.stage === "repo" && d.code === "search-failed"),
);
must(
  "в сообщении видна настоящая причина от стора",
  (diagnostics[0]?.message ?? "").includes("unable to open database file"),
);
must(
  "полный recall тоже доносит причину, а не молча возвращает пустоту",
  recallDiagnostics.some((d) => d.stage === "repo"),
);

store.close();
fs.rmSync(dir, { recursive: true, force: true });
finish();
