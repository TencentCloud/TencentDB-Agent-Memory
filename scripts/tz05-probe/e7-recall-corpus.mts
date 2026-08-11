/**
 * tz-05 e7 — корпус recall до и после включения strict.
 *
 * Риск R3: сужение выдачи. Порог из плана — не «выдача не просела» (она обязана
 * просесть, в этом смысл фильтра), а «каждая выпавшая запись объясняется своим
 * scope». Проба берёт корпус из четырёх классов, снимает выдачу в legacy и в
 * strict и разбирает разницу поимённо.
 *
 * Режим фальсификации: FALSIFY=hide-everything — предикат режет и записи своего
 * проекта. Выпавшая запись перестаёт объясняться своим scope, и нога краснеет:
 * без неё проба была бы зелёной при любом сужении, включая полное.
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
const OWN = "/repo/own";
const OTHER = "/repo/other";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz05-e7-"));
const store = new VectorStore(path.join(dir, "vectors.db"), 8);
await store.init();

/** Корпус: 40 записей четырёх классов, по 10 в каждом. */
const CLASSES = [
  { kind: "own", scope: "project", projectId: OWN },
  { kind: "other", scope: "project", projectId: OTHER },
  { kind: "global", scope: "global", projectId: OTHER },
  { kind: "unset", scope: "project", projectId: OWN },
] as const;

const VEC = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
for (const c of CLASSES) {
  for (let i = 0; i < 10; i += 1) {
    await store.upsertL1(
      {
        id: `${c.kind}-${i}`,
        content: `checklist entry ${c.kind} ${i}`,
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
        projectId: c.projectId,
        scope: c.scope,
      } as MemoryRecord,
      VEC,
    );
  }
}
// Класс «без scope» существует только как строка, написанная до появления
// колонки: писатель проставляет 'global' по умолчанию (sqlite.ts:1178).
{
  const raw = new DatabaseSync(path.join(dir, "vectors.db"));
  raw
    .prepare(
      "UPDATE l1_records SET scope = NULL WHERE record_id LIKE 'unset-%'",
    )
    .run();
  raw.close();
}

async function recall(scopeFilter: "legacy" | "attribute"): Promise<string[]> {
  const cfg = parseConfig({
    recall: {
      strategy: "keyword",
      maxResults: 100,
      scoreThreshold: 0,
      scopeFilter,
    },
  });
  // Фальсификация: режим strict подменяется на «показывать ничего своего» —
  // проверяем, что нога про объяснимость действительно смотрит на scope.
  if (FALSIFY === "hide-everything" && scopeFilter === "attribute") {
    (cfg.recall as { crossProject?: string }).crossProject = "hidden";
  }
  const result = await searchMemories(
    "checklist",
    dir,
    cfg,
    undefined,
    "keyword",
    store,
    undefined,
    FALSIFY === "hide-everything" && scopeFilter === "attribute"
      ? "/repo/несуществующий"
      : OWN,
  );
  return result.lines
    .map((l) => /entry (\w+) (\d+)/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${m[1]}-${m[2]}`)
    .sort();
}

const before = await recall("legacy");
const after = await recall("attribute");
const dropped = before.filter((id) => !after.includes(id));

function classOf(id: string): string {
  return id.split("-")[0]!;
}

const counts = (ids: string[]): string =>
  ["own", "other", "global", "unset"]
    .map((k) => `${k}=${ids.filter((id) => classOf(id) === k).length}`)
    .join(" ");

console.log(`  legacy:    ${before.length} записей (${counts(before)})`);
console.log(`  attribute: ${after.length} записей (${counts(after)})`);
console.log(`  выпало:    ${dropped.length} (${counts(dropped)})`);

// Объяснимо выпадение записи БЕЗ scope: strict пропускает только явные
// 'global' и свой проект. Всё остальное выпасть не может.
const unexplained = dropped.filter((id) => classOf(id) !== "unset");
console.log(
  `  необъяснённых выпадений: ${unexplained.length}${unexplained.length ? ` — ${unexplained.join(", ")}` : ""}`,
);

must("в legacy виден весь корпус, кроме чужого проекта", before.length === 30);
must(
  "strict сузил выдачу — фильтр действительно работает",
  after.length < before.length,
);
must(
  "каждая выпавшая запись объясняется своим scope: выпал только класс без scope",
  unexplained.length === 0,
);
must(
  "записи своего проекта и global не пострадали",
  after.filter((id) => classOf(id) === "own").length === 10 &&
    after.filter((id) => classOf(id) === "global").length === 10,
);

store.close();
fs.rmSync(dir, { recursive: true, force: true });
finish();
