/**
 * tz-03a Ф5 — два ПРОЦЕССА финализируют одновременно (ТЗ A2b :76,
 * критерий 3a :88).
 *
 * Внутрипроцессный лок в checkpoint.ts — это `Map` в памяти модуля: у двух
 * gateway разные карты, оба читают свой снимок и оба переименовывают файл
 * поверх чужого. Проба обязана спавнить РЕАЛЬНЫЕ процессы: один процесс с
 * двумя промисами был бы зелёным и при полностью отсутствующей межпроцессной
 * защите.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=no-lock — дочерний процесс пишет чекпойнт напрямую,
 * без hard-link лока (read-modify-write как было). Записи теряются.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ConsolidationCheckpoint } from "../../src/gateway/consolidation/checkpoint.js";
import { makeSandbox } from "../tz09-probe/sandbox.mts";
import { must, finish } from "../tz07-probe/assert.mts";

const SELF = fileURLToPath(import.meta.url);
const FALSIFY = process.env.FALSIFY ?? "";
const ROUNDS = 12;

// ============================================================
// Дочерний режим: пишет ROUNDS отметок ролей со своим префиксом.
// ============================================================
if (process.env.C5_CHILD !== undefined) {
  const dataDir = process.env.C5_DATA_DIR!;
  const tag = process.env.C5_CHILD;
  const cp = new ConsolidationCheckpoint(dataDir);
  const file = path.join(dataDir, ".metadata", "consolidation_checkpoint.json");

  for (let i = 0; i < ROUNDS; i++) {
    if (FALSIFY === "no-lock") {
      // Как было до пакета: читаем, думаем, пишем — без межпроцессной защиты.
      const data = fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, "utf-8")) as {
            roles: Record<string, unknown>;
          })
        : { roles: {} };
      await new Promise((r) => setTimeout(r, 5));
      data.roles[`${tag}-${i}`] = { lastRunAt: "x", errors: 0 };
      const tmp = `${file}.tmp.${process.pid}.${i}`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmp, file);
    } else {
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
// Родительский режим.
// ============================================================
console.log(`FALSIFY=${FALSIFY || "(нет)"}`);
const sandbox = makeSandbox([]);

function child(tag: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("npx", ["tsx", SELF], {
      env: {
        ...process.env,
        C5_CHILD: tag,
        C5_DATA_DIR: sandbox.dataDir,
        FALSIFY,
      },
      stdio: "ignore",
    });
    proc.on("close", (code) => resolve(code ?? 1));
  });
}

const [codeA, codeB] = await Promise.all([child("a"), child("b")]);
console.log(`  коды выхода процессов: ${codeA}, ${codeB}`);

const data = await new ConsolidationCheckpoint(sandbox.dataDir).read();
const keys = Object.keys(data.roles).sort();
const expected = ROUNDS * 2;
console.log(`  записей в roles: ${keys.length} из ${expected} ожидаемых`);
const missing = [];
for (const tag of ["a", "b"]) {
  for (let i = 0; i < ROUNDS; i++) {
    if (data.roles[`${tag}-${i}`] === undefined) missing.push(`${tag}-${i}`);
  }
}
console.log(`  потеряно: ${missing.length ? missing.join(", ") : "ничего"}`);

must("оба процесса завершились без ошибки", codeA === 0 && codeB === 0);
must(
  "ни одна запись из двух ПРОЦЕССОВ не потеряна",
  keys.length === expected && missing.length === 0,
);

sandbox.cleanup();
finish();
