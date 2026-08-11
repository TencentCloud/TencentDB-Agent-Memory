/**
 * tz-03b Ф6 — критерий 3a на НОВЫХ полях (ТЗ :88): два процесса пишут счётчики
 * в один checkpoint-файл, и ни одна запись не теряется.
 *
 * Новые поля кладутся тем же `checkpoint.update`, что и курсор tz-03a, поэтому
 * межпроцессный hard-link лок им достаётся даром — но «достаётся даром» это
 * рассуждение, а проба обязана быть наблюдением. Спавнятся РЕАЛЬНЫЕ процессы:
 * один процесс с двумя промисами был бы зелёным и без всякой защиты.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=no-lock — ребёнок пишет файл сам, read-modify-write
 * без лока. Записи теряются.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ConsolidationCheckpoint } from "../../src/gateway/consolidation/checkpoint.js";
import { recomputeCounters } from "../../src/gateway/consolidation/layer-counters.js";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";

const SELF = fileURLToPath(import.meta.url);
const FALSIFY = process.env.FALSIFY ?? "";
const ROUNDS = 10;

// ============================================================
// Дочерний режим: ROUNDS пересчётов + своя отметка на каждый круг.
// ============================================================
if (process.env.D7_CHILD !== undefined) {
  const dataDir = process.env.D7_DATA_DIR!;
  const tag = process.env.D7_CHILD;
  const rows = Number(process.env.D7_ROWS ?? "0");
  const cp = new ConsolidationCheckpoint(dataDir);
  const file = path.join(dataDir, ".metadata", "consolidation_checkpoint.json");
  const store = { countL1: () => rows };

  for (let i = 0; i < ROUNDS; i++) {
    if (FALSIFY === "no-lock") {
      const data = fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
            string,
            unknown
          >)
        : { roles: {} };
      await new Promise((r) => setTimeout(r, 5));
      data.l1Count = rows;
      (data.roles as Record<string, unknown>)[`${tag}-${i}`] = {
        lastRunAt: "x",
        errors: 0,
      };
      const tmp = `${file}.tmp.${process.pid}.${i}`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmp, file);
    } else {
      await recomputeCounters(dataDir, store);
      await cp.update((d) => {
        d.roles[`${tag}-${i}`] = {
          lastRunAt: "x",
          recordsProcessed: 0,
          overLimitBlocks: 0,
          merges: 0,
          rewrites: 0,
          errors: 0,
        };
      });
    }
  }
  process.exit(0);
}

// ============================================================
// Родитель
// ============================================================
const sandbox = makeSandbox([]);
fs.mkdirSync(path.join(sandbox.dataDir, "scene_blocks", "_global"), {
  recursive: true,
});
fs.writeFileSync(
  path.join(sandbox.dataDir, "scene_blocks", "_global", "a.md"),
  "# блок",
  "utf-8",
);

function child(tag: string, rows: number): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("npx", ["tsx", SELF], {
      env: {
        ...process.env,
        D7_CHILD: tag,
        D7_DATA_DIR: sandbox.dataDir,
        D7_ROWS: String(rows),
        FALSIFY,
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

const [a, b] = await Promise.all([child("alpha", 42), child("beta", 42)]);
const data = await new ConsolidationCheckpoint(sandbox.dataDir).read();
const keys = Object.keys(data.roles);
const expected = ROUNDS * 2;

console.log(
  `  дети завершились: alpha=${a}, beta=${b}; отметок ${keys.length} из ${expected}; ` +
    `l1Count=${data.l1Count}, sceneCount=${data.sceneCount}`,
);

must("оба процесса завершились без ошибки", a === 0 && b === 0);
must(
  "ни одна запись двух процессов не потеряна (критерий 3a на новых полях)",
  keys.length === expected,
);
must(
  "счётчики после конкурентных пересчётов равны факту",
  data.l1Count === 42 && data.sceneCount === 1,
);

sandbox.cleanup();
finish();
