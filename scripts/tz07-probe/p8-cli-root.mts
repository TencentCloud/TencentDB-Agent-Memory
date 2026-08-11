/**
 * tz-07, раунд 3: две дыры одной природы — «корень взят не оттуда».
 *
 * (а) CLI без композиционного корня. scripts/reindex-embeddings.ts резолвил
 *     DB_PATH от defaultTdaiRoot(), который НЕ читает yaml `data.baseDir`. На
 *     yaml-укоренённой установке скрипт переиндексировал пустую базу, печатал
 *     "done: l1Count=0, l0Count=0" и выходил с нулём — тихий R1-раскол.
 * (б) env-ступень. MEMORY_TENCENTDB_ROOT тоже именует корень, значит установка
 *     с ним — НЕ дефолтная и не имеет права наследовать ~/.pi.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=default-root — резолвить обратно от defaultTdaiRoot()
 * и считать env-ступень дефолтной, как было до фикса. Обе ноги обязаны покраснеть.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEnv } from "../../src/utils/env.js";
import { loadGatewayConfig } from "../../src/gateway/config.js";
import {
  defaultTdaiRoot,
  resetTdaiRootCacheForTests,
  resolveUnderRoot,
} from "../../src/gateway/tdai-root.js";
import { must, finish } from "./assert.mts";

const OLD = process.env.FALSIFY === "default-root";

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz07-p8-"));
process.env.HOME = home;
delete process.env.TDAI_DATA_DIR;
delete process.env.MEMORY_TENCENTDB_ROOT;
delete process.env.TDAI_GATEWAY_CONFIG;

// --- (а) yaml-укоренённая установка, как на этом хосте ----------------------
const yamlRoot = path.join(home, "yaml-root");
fs.mkdirSync(yamlRoot, { recursive: true });
const cwd = path.join(home, "repo");
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(
  path.join(cwd, "tdai-gateway.yaml"),
  `data:\n  baseDir: ${yamlRoot}\n`,
);
process.chdir(cwd);
resetTdaiRootCacheForTests();

// Ровно то выражение, что стоит в scripts/reindex-embeddings.ts.
const dbPath = OLD
  ? resolveUnderRoot(defaultTdaiRoot(), "vectors.db")
  : resolveUnderRoot(loadGatewayConfig().data.baseDir, "vectors.db");
console.log(`  корень из yaml: ${yamlRoot}`);
console.log(`  DB_PATH скрипта: ${dbPath}`);
must(
  "CLI берёт базу из yaml-корня",
  dbPath === path.join(yamlRoot, "vectors.db"),
);
must(
  "CLI не уходит в дефолтный корень",
  !dbPath.startsWith(defaultTdaiRoot() + path.sep),
);

// --- (б) env-ступень --------------------------------------------------------
process.env.MEMORY_TENCENTDB_ROOT = path.join(home, "container");
fs.rmSync(path.join(cwd, "tdai-gateway.yaml")); // yaml убран: судим ровно env
resetTdaiRootCacheForTests();
const viaEnv = loadGatewayConfig();
console.log(`  MEMORY_TENCENTDB_ROOT → baseDir: ${viaEnv.data.baseDir}`);
console.log(`  baseDirIsDefault: ${OLD ? true : viaEnv.data.baseDirIsDefault}`);
must(
  "корень назван env → установка не дефолтная",
  (OLD ? true : viaEnv.data.baseDirIsDefault) === false,
);
must(
  "и baseDir действительно уехал под этот корень",
  viaEnv.data.baseDir.startsWith(path.join(home, "container") + path.sep),
);

// Обратный ход: снял переменную — установка снова дефолтная и наследует.
delete process.env.MEMORY_TENCENTDB_ROOT;
resetTdaiRootCacheForTests();
must(
  "снял переменную → снова дефолт",
  loadGatewayConfig().data.baseDirIsDefault,
);

process.chdir(os.tmpdir());
fs.rmSync(home, { recursive: true, force: true });

finish();
