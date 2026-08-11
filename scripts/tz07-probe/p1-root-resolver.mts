/**
 * tz-07 Ф1: корень резолвится там, где ему сказали, и не ходит в ФС на каждый
 * вызов (H1, НФТ :123).
 *
 * Две наблюдаемые вещи:
 *  1) явный аргумент и env дают РАЗНЫЕ деревья — резолвер не игнорирует то,
 *     что ему передали (без этого «один корень» недоказуем: совпадение путей
 *     выглядит как успех и при полностью сломанном резолвере);
 *  2) N резолвов стоят столько же обращений к ФС, сколько один.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=no-cache — сбрасывать мемоизацию перед каждым
 * вызовом через собственный API модуля. Счётчик обязан вырасти линейно; если
 * и там он остаётся плоским, наблюдение слепое и первая половина ничего не
 * значит.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  allowLegacyFallback,
  defaultTdaiRoot,
  legacyReadPath,
  resolveUnderRoot,
  resetTdaiRootCacheForTests,
} from "../../src/gateway/tdai-root.js";
import { must, finish } from "./assert.mts";

const NO_CACHE = process.env.FALSIFY === "no-cache";
const N = 50;
const PARTS = [
  "roles",
  "logs",
  "scratch",
  "records",
  "vectors.db",
  "persona.md",
];

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);

// --- 1. Аргумент против env -------------------------------------------------
const explicit = fs.mkdtempSync(path.join(os.tmpdir(), "tz07-explicit-"));
const viaEnv = fs.mkdtempSync(path.join(os.tmpdir(), "tz07-env-"));
process.env.TDAI_DATA_DIR = viaEnv;
resetTdaiRootCacheForTests();

const fromArg = PARTS.map((p) => resolveUnderRoot(explicit, p));
const fromEnv = PARTS.map((p) => resolveUnderRoot(defaultTdaiRoot(), p));
const allUnderArg = fromArg.every((p) => p.startsWith(explicit + path.sep));
const allUnderEnv = fromEnv.every((p) => p.startsWith(viaEnv + path.sep));
const disjoint = fromArg.every((p, i) => p !== fromEnv[i]);

must("шесть путей под явным корнем", allUnderArg);
must("шесть путей под env-корнем", allUnderEnv);
must("деревья различны", disjoint);

// --- 2. Цена резолва --------------------------------------------------------
// Мерить надо ветку, в которой I/O ЕСТЬ: при заданном TDAI_DATA_DIR резолвер
// конфига не вызывается вовсе, счётчик остаётся нулём в обеих ногах, и
// фальсификация становится пустой. Поэтому здесь env-корень снимается, а
// корень задаётся через MEMORY_TENCENTDB_ROOT — тот путь, где
// resolveDefaultDataDir проверяет существование нового и legacy каталогов.
delete process.env.TDAI_DATA_DIR;
process.env.MEMORY_TENCENTDB_ROOT = viaEnv;
resetTdaiRootCacheForTests();

const realExists = fs.existsSync;
let statCalls = 0;
fs.existsSync = (p: fs.PathLike) => {
  statCalls += 1;
  return realExists(p);
};

// Цена ОДНОГО резолва на холодном кэше — эталон сравнения. Резолв стоит два
// обращения (новый каталог + legacy), поэтому порог «<= 1» был бы неверен.
defaultTdaiRoot();
const perOne = statCalls;

statCalls = 0;
resetTdaiRootCacheForTests();
for (let i = 0; i < N; i += 1) {
  if (NO_CACHE) resetTdaiRootCacheForTests();
  defaultTdaiRoot();
}
fs.existsSync = realExists;

console.log(`цена одного резолва:           ${perOne}`);
console.log(`обращений к ФС на ${N} резолвов: ${statCalls}`);
console.log(
  NO_CACHE
    ? `  ожидание при снятой мемоизации: ${N * perOne} (кэша нет)`
    : `  ожидание при мемоизации: ${perOne}`,
);
must("кэш держит (без FALSIFY)", statCalls === perOne);

// --- 3. Legacy — только на чтение ------------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz07-home-"));
process.env.HOME = home;
const legacyRoles = path.join(home, ".pi", "agent-memory", "tdai", "roles");
fs.mkdirSync(legacyRoles, { recursive: true });
// Fallback теперь opt-in: объявляем корень установкой, иначе нога проверяет
// не правило, а его отсутствие.
allowLegacyFallback(explicit);
const readBack = legacyReadPath(explicit, "roles");
const missing = legacyReadPath(explicit, "nothing-here");
must("чтение уходит в legacy", readBack === legacyRoles);
must(
  "отсутствующее — под НОВЫМ корнем",
  missing === path.join(explicit, "nothing-here"),
);

for (const d of [explicit, viaEnv, home]) {
  fs.rmSync(d, { recursive: true, force: true });
}

finish();
