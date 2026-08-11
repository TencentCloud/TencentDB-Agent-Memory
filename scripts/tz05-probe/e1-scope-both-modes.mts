/**
 * tz-05 e1 — scope в обоих режимах флага, через НАСТОЯЩИЙ путь recall.
 *
 * Проба не дёргает `passesScope` напрямую: она собирает конфиг через
 * `parseConfig` — тот самый, что читает продукт, — и вызывает `searchMemories`
 * с реальным `VectorStore`. Так проверяется вся цепочка «флаг в конфиге →
 * режим → SQL-предикат», а не одна функция посередине.
 *
 * Режим фальсификации: FALSIFY=drop-default — дефолт флага считается
 * `attribute` вместо `legacy`. Нога «конфиг без флага ведёт себя по-старому»
 * обязана покраснеть: это и есть путь отката всего пакета.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseConfig } from "../../src/config.js";
import { VectorStore } from "../../src/core/store/sqlite.js";
import { searchMemories } from "../../src/core/hooks/auto-recall/search.js";
import type { MemoryRecord } from "../../src/core/record/l1-writer.js";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
const PROJECT = "/repo/own";
const OTHER = "/repo/other";
const TEXT = "инструкция по деплою альфа";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz05-e1-"));
const store = new VectorStore(path.join(dir, "vectors.db"), 8);
await store.init();

function record(id: string, scope: string, projectId: string): MemoryRecord {
  return {
    id,
    content: `${TEXT} — ${id}`,
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
    projectId,
    scope,
  } as MemoryRecord;
}

const VEC = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
await store.upsertL1(record("own", "project", PROJECT), VEC);
await store.upsertL1(record("other", "project", OTHER), VEC);
await store.upsertL1(record("global", "global", OTHER), VEC);
// Запись «без scope» — единственный класс, который отличает legacy от strict.
// Писатель проставляет scope по умолчанию (sqlite.ts:1178), так что через него
// такую строку не получить: она бывает только как строка, написанная до
// появления колонки, и здесь воспроизводится напрямую.
await store.upsertL1(record("unset", "project", PROJECT), VEC);
{
  const raw = new DatabaseSync(path.join(dir, "vectors.db"));
  raw
    .prepare("UPDATE l1_records SET scope = NULL WHERE record_id = 'unset'")
    .run();
  raw.close();
}

/** Какие записи видны при данном значении флага. */
async function visible(scopeFilter?: string): Promise<string[]> {
  const raw: Record<string, unknown> = {
    recall: {
      strategy: "keyword",
      maxResults: 20,
      scoreThreshold: 0,
      ...(scopeFilter ? { scopeFilter } : {}),
    },
  };
  const cfg = parseConfig(raw);
  // Фальсификация: делаем вид, что дефолт флага — attribute.
  if (FALSIFY === "drop-default" && !scopeFilter) {
    (cfg.recall as { scopeFilter?: string }).scopeFilter = "attribute";
  }
  const result = await searchMemories(
    "деплою",
    dir,
    cfg,
    undefined,
    "keyword",
    store,
    undefined,
    PROJECT,
  );
  return ["own", "other", "global", "unset"]
    .filter((id) => result.lines.some((l) => l.includes(`— ${id}`)))
    .sort();
}

const legacy = await visible();
const attribute = await visible("attribute");
console.log(`  флаг не задан (legacy):  ${legacy.join(", ") || "(пусто)"}`);
console.log(`  флаг attribute (strict): ${attribute.join(", ") || "(пусто)"}`);
console.log(
  `  scopeFilter по умолчанию: ${parseConfig({}).recall.scopeFilter}`,
);

must(
  "конфиг без флага ведёт себя по-старому: свой, global и запись без scope видны, чужой скрыт",
  legacy.join(",") === "global,own,unset",
);
must(
  "флаг attribute отсекает запись без scope — тем и отличается strict от legacy",
  !attribute.includes("unset"),
);
must(
  "флаг attribute даёт strict: чужой проект по-прежнему скрыт",
  !attribute.includes("other"),
);
must(
  "и в strict свой проект и global на месте",
  attribute.includes("own") && attribute.includes("global"),
);
must(
  "дефолт значения флага в конфиге — legacy",
  parseConfig({}).recall.scopeFilter === "legacy",
);

store.close();
fs.rmSync(dir, { recursive: true, force: true });
finish();
