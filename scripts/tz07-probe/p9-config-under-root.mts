/**
 * tz-07 H2, находка независимого критика: конфиг РЕЛОЦИРОВАННОЙ установки
 * обязан быть виден лоадеру, который её релоцировал.
 *
 * resolveConfigPath() шаг 3 искал yaml под ДЕФОЛТНЫМ корнем, а не под тем,
 * который назвали. Установка с TDAI_DATA_DIR=<X> и <X>/tdai-gateway.yaml
 * молча стартовала на дефолтах: порт 8420 вместо заданного, ключи и лимиты —
 * тоже. Тихо, без единой строки в логе.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=default-only — искать под дефолтным корнем, как было.
 * Первая нога обязана покраснеть. Третья нога (yaml в дефолтном корне при
 * ЗАДАННОМ env-корне не подхватывается) под фальсификацией краснеет наоборот —
 * она стережёт, чтобы фикс не превратился в «читаем оба места».
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadGatewayConfig,
  resolveDefaultDataDir,
} from "../../src/gateway/config.js";
import { resetTdaiRootCacheForTests } from "../../src/gateway/tdai-root.js";
import { must, finish } from "./assert.mts";

const OLD = process.env.FALSIFY === "default-only";

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz07-p9-"));
process.env.HOME = home;
delete process.env.TDAI_GATEWAY_CONFIG;
delete process.env.MEMORY_TENCENTDB_ROOT;
delete process.env.TDAI_GATEWAY_PORT;

// cwd — ВНЕ репозитория и пустой: иначе шаг 2 (yaml в cwd) перехватит поиск и
// нога будет измерять не то. Именно так эта дыра и пряталась.
const emptyCwd = path.join(home, "cwd");
fs.mkdirSync(emptyCwd, { recursive: true });
process.chdir(emptyCwd);

/** Прочитать конфиг с корнем, заданным через env. */
function loadWithRoot(root: string): ReturnType<typeof loadGatewayConfig> {
  process.env.TDAI_DATA_DIR = OLD ? "" : root;
  if (OLD) delete process.env.TDAI_DATA_DIR;
  resetTdaiRootCacheForTests();
  return loadGatewayConfig();
}

// --- 1. Конфиг под названным корнем -----------------------------------------
const moved = path.join(home, "moved-root");
fs.mkdirSync(moved, { recursive: true });
fs.writeFileSync(
  path.join(moved, "tdai-gateway.yaml"),
  "server:\n  port: 9999\n",
  "utf-8",
);
const cfg = loadWithRoot(moved);
console.log(`  порт из конфига релоцированной установки: ${cfg.server.port}`);
must("конфиг под названным корнем прочитан", cfg.server.port === 9999);

// --- 2. Дефолтная установка не сломалась ------------------------------------
delete process.env.TDAI_DATA_DIR;
resetTdaiRootCacheForTests();
const defaultRoot = resolveDefaultDataDir();
fs.mkdirSync(defaultRoot, { recursive: true });
fs.writeFileSync(
  path.join(defaultRoot, "tdai-gateway.yaml"),
  "server:\n  port: 8888\n",
  "utf-8",
);
resetTdaiRootCacheForTests();
const dflt = loadGatewayConfig();
console.log(`  порт дефолтной установки: ${dflt.server.port}`);
must("дефолтная установка читает свой конфиг", dflt.server.port === 8888);

// --- 3. Названный корень НЕ подглядывает в дефолтный ------------------------
// Под moved-root свой yaml лежит с портом 9999, под дефолтным — 8888. Если
// фикс превратится в «искать в обоих местах», порядок решит исход втихую.
fs.rmSync(path.join(moved, "tdai-gateway.yaml"));
const movedNoCfg = loadWithRoot(moved);
console.log(`  корень без конфига → порт: ${movedNoCfg.server.port}`);
must(
  "чужой конфиг из дефолтного корня не подхватывается",
  movedNoCfg.server.port === 8420,
);

process.chdir(os.tmpdir());
fs.rmSync(home, { recursive: true, force: true });

finish();
