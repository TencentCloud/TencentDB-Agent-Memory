/**
 * tz-07 Ф7, S2: «задать корень явно тем же значением, что и дефолт, —
 * поведение обязано совпасть до файла».
 *
 * Три прогона, а не два. Равенство деревьев в одиночку — ПУСТОЕ наблюдение:
 * оно сохраняется и тогда, когда резолвер вовсе игнорирует свой аргумент.
 * Поэтому третий прогон задаёт ДРУГОЙ корень, и дерево обязано разойтись.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=ignore-arg — резолвить всё от дефолта, что бы ни
 * передали. Первые два прогона останутся равны (и «успех» сохранится), а
 * третий сравняется с ними — вот это и есть провал.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveRoleDir } from "../../src/gateway/role-paths.js";
import {
  defaultTdaiRoot,
  resetTdaiRootCacheForTests,
  resolveUnderRoot,
} from "../../src/gateway/tdai-root.js";
import { must, finish } from "./assert.mts";

const IGNORE_ARG = process.env.FALSIFY === "ignore-arg";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz07-p7b-"));
process.env.HOME = home;
const defaultRoot = path.join(home, "default-root");
process.env.TDAI_DATA_DIR = defaultRoot;
resetTdaiRootCacheForTests();

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
console.log(`дефолтный корень: ${defaultTdaiRoot()}`);

/** Разложить одинаковый набор данных под указанным корнем и снять хэш дерева. */
function layout(root: string, label: string): string {
  const effective = IGNORE_ARG ? defaultTdaiRoot() : root;
  const base = path.join(home, "runs", label);
  fs.mkdirSync(base, { recursive: true });
  const paths = [
    resolveRoleDir(effective),
    resolveUnderRoot(effective, "logs"),
    resolveUnderRoot(effective, ".metadata"),
  ];
  const h = createHash("sha256");
  for (const p of paths) {
    // Относительно $HOME, чтобы сравнивать СТРУКТУРУ, а не имя временного каталога.
    h.update(path.relative(home, p));
  }
  return h.digest("hex").slice(0, 16);
}

const a = layout(defaultTdaiRoot(), "default"); // корень не задан явно
const b = layout(defaultRoot, "explicit-same"); // задан тем же значением
const c = layout(path.join(home, "other-root"), "explicit-other"); // ДРУГОЙ

console.log(`  дефолт:              ${a}`);
console.log(`  явно, то же значение: ${b}`);
console.log(`  явно, ДРУГОЙ корень:  ${c}`);
must("совпали до файла (S2)", a === b);
must("другой корень даёт другое дерево", c !== a);

fs.rmSync(home, { recursive: true, force: true });

finish();
