/**
 * tz-05 e4 — план запроса на пути recall.
 *
 * Кристалл §2.11 закрыл пункт про `idx_l1_scope_project` наблюдением, а не
 * работой: на пути recall планировщик до него не доходит ни в одном варианте
 * предиката. Наблюдение живёт здесь, чтобы «индекс не используется» перестало
 * быть утверждением на слово и стало проверяемым фактом.
 *
 * Причина не в форме предиката: FTS-таблица ведёт JOIN, `l1_records` читается
 * по её ключу (PRIMARY KEY на record_id), и второй индекс планировщику не
 * нужен. Проба печатает планы обоих вариантов и обоих режимов целиком.
 *
 * Режим фальсификации: FALSIFY=expect-index — ждём индекс на пути recall.
 * Проба обязана покраснеть: это фиксирует, что нога действительно смотрит на
 * план, а не подтверждает саму себя.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../../src/core/store/sqlite.js";
import type { MemoryRecord } from "../../src/core/record/l1-writer.js";
import { must, finish } from "../tz07-probe/assert.mts";

const FALSIFY = process.env.FALSIFY ?? "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz05-e4-"));
const dbPath = path.join(dir, "vectors.db");
const store = new VectorStore(dbPath, 8);
await store.init();

// Схему и индексы создаёт сам стор; строки нужны, чтобы у планировщика была
// статистика, а не пустая таблица.
for (let i = 0; i < 50; i += 1) {
  await store.upsertL1(
    {
      id: `r${i}`,
      content: `deployment checklist number ${i}`,
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
      projectId: i % 2 === 0 ? "/repo/own" : "/repo/other",
      scope: i % 3 === 0 ? "global" : "project",
    } as MemoryRecord,
    new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
  );
}
store.close();

const db = new DatabaseSync(dbPath);
db.exec("ANALYZE");

/** Тот же SQL, что готовит стор (`sqlite.ts:920`) — предикат из Ф4. */
const RECALL_SQL = `
  SELECT l1_fts.record_id, r.project_id, COALESCE(r.scope, '') AS scope, bm25(l1_fts) AS rank
  FROM l1_fts
  JOIN l1_records r ON r.record_id = l1_fts.record_id
  WHERE l1_fts MATCH ?1
    AND (
      ?2 = '' OR ?2 = '__decay_all__'
      OR (?4 = 'hidden' AND (COALESCE(r.scope, '') <> 'project' OR r.project_id = ?2))
      OR (?4 = 'strict' AND (COALESCE(r.scope, '') = 'global'
                             OR (COALESCE(r.scope, '') = 'project' AND r.project_id = ?2)))
    )
  ORDER BY rank ASC
  LIMIT ?3
`;

/** Вариант «переписанный предикат»: scope вынесен вперёд, без COALESCE. */
const REWRITTEN_SQL = `
  SELECT l1_fts.record_id
  FROM l1_fts
  JOIN l1_records r ON r.record_id = l1_fts.record_id
  WHERE l1_fts MATCH ?1
    AND r.scope IN ('global', 'project')
    AND (r.scope = 'global' OR r.project_id = ?2)
  LIMIT ?3
`;

function plan(sql: string, ...args: Array<string | number>): string[] {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((row) => String((row as { detail: string }).detail));
}

const plans: Array<[string, string[]]> = [
  [
    "предикат из Ф4 (боевой)",
    plan(RECALL_SQL, "checklist", "/repo/own", 10, "strict"),
  ],
  ["переписанный предикат", plan(REWRITTEN_SQL, "checklist", "/repo/own", 10)],
];

for (const [label, lines] of plans) {
  console.log(`  ${label}:`);
  for (const line of lines) console.log(`    ${line}`);
}

const usesScopeIndex = plans.some(([, lines]) =>
  lines.some((l) => l.includes("idx_l1_scope_project")),
);
const wantIndex = FALSIFY === "expect-index";

must(
  "индекс idx_l1_scope_project действительно создан — иначе нечего и мерить",
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
    .all("idx_l1_scope_project").length === 1,
);
must(
  wantIndex
    ? "план recall использует idx_l1_scope_project"
    : "план recall НЕ использует idx_l1_scope_project ни в одном варианте предиката",
  usesScopeIndex === wantIndex,
);
must(
  "JOIN идёт от FTS-таблицы к l1_records по её собственному ключу record_id — вот почему второй индекс не нужен",
  plans[0]![1].some(
    (l) =>
      l.includes("sqlite_autoindex_l1_records_1") && l.includes("record_id=?"),
  ),
);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
finish();
