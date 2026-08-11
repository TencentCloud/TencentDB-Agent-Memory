/**
 * tz-07 Ф7, критерий 2 (положительная половина) + S1 + `inspectable-run`.
 *
 * S1 дословно: «расщепление данных между корнями — главный риск пакета, и оно
 * выглядит как успех, если смотреть только на новый путь». Поэтому проба
 * перечисляет ШЕСТЬ видов данных поимённо и требует, чтобы под старым корнем
 * не осталось НИ ОДНОГО из них.
 *
 * Корень задаётся НЕ через env: `logDir` в server.ts берётся от
 * `config.data.baseDir`, и проба, задающая TDAI_DATA_DIR, эту разницу не
 * увидела бы (дефолт совпал бы с baseDir).
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=one-site-missed — одно место (логи) оставить на
 * старом корне. Проба обязана назвать именно его; если она остаётся зелёной,
 * она смотрит только на новый путь — та самая слепота из S1.
 *
 * FALSIFY=metadata-default — отдать readScratchDiff дефолтный корень вместо
 * конфигурационного (код до раунда 4). Красит yaml-ступень внизу: именно там
 * defaultTdaiRoot() расходится с конфигом, и именно этого первые шесть
 * наблюдений не видели — они сверяли резолвер, а не пишущий код.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRoleDir } from "../../src/gateway/role-paths.js";
import {
  defaultTdaiRoot,
  resetTdaiRootCacheForTests,
  resolveUnderRoot,
} from "../../src/gateway/tdai-root.js";
import { loadGatewayConfig } from "../../src/gateway/config.js";
import { readScratchDiff } from "../../src/gateway/consolidation/scratch-diff.js";
import { resolveLogFile } from "../../src/utils/dev-logger.js";
import { hostTaskRoots } from "../../src/gateway/consolidation/launchers/auth-root.js";
import { must, finish } from "./assert.mts";

const MISSED = process.env.FALSIFY === "one-site-missed";
const MISSED_META = process.env.FALSIFY === "metadata-default";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz07-p7-"));
process.env.HOME = home;
const legacyRoot = path.join(home, ".pi", "agent-memory", "tdai");
const root = path.join(home, "moved-root");
fs.mkdirSync(root, { recursive: true });

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
console.log(`корень: ${root}`);

// Шесть видов данных из критерия 2, каждый — своим резолвером, а не строкой.
const sites: Array<[string, string]> = [
  ["роли", resolveRoleDir(root)],
  ["промпты", path.join(resolveRoleDir(root), "memory-keeper")],
  ["scratch", resolveUnderRoot(root, "scratch")],
  [
    "сессии",
    resolveUnderRoot(root, "scratch", "run-1", "attempts", "a1", "session"),
  ],
  [
    "логи",
    MISSED
      ? path.join(legacyRoot, "logs", "gateway-dev.log")
      : resolveLogFile(resolveUnderRoot(root, "logs")),
  ],
  ["метаданные", resolveUnderRoot(root, ".metadata")],
];

let underNew = 0;
const strays: string[] = [];
for (const [name, p] of sites) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(p), ".probe"), "x", "utf-8");
  const ok = p.startsWith(root + path.sep);
  if (ok) underNew += 1;
  else strays.push(`${name} → ${p}`);
  console.log(
    `  ${name.padEnd(11)} ${ok ? "под новым корнем" : "СНАРУЖИ"}: ${p}`,
  );
}

console.log(`под новым корнем: ${underNew}/${sites.length}`);
must("все шесть видов данных под новым корнем", underNew === sites.length);
if (strays.length > 0) console.log(`промахнулись: ${strays.join("; ")}`);

// Старый корень обязан остаться пустым — S1: успех «по новому пути» ничего не
// значит, если часть данных продолжает капать в старый.
const legacyLeftovers = fs.existsSync(legacyRoot)
  ? fs.readdirSync(legacyRoot)
  : [];
must(
  `под СТАРЫМ корнем ничего не появилось${legacyLeftovers.length ? ` (там: ${legacyLeftovers.join(", ")})` : ""}`,
  legacyLeftovers.length === 0,
);

// inspectable-run: корень задач хоста — тоже не под памятью.
console.log(`корни задач хоста (pi): ${hostTaskRoots(["pi"]).join(", ")}`);

// --- yaml-ступень, ПРОДОВЫМ путём ------------------------------------------
// Слепой угол, предсказанный шапкой этой пробы и найденный на раунде 4: выше
// «метаданные» проверены резолвером, а не кодом, который их пишет. Тут лог
// пишет НАСТОЯЩИЙ readScratchDiff, и корень приходит из yaml — единственной
// ступени, где defaultTdaiRoot() расходится с конфигом.
const cwd = path.join(home, "repo");
fs.mkdirSync(cwd, { recursive: true });
const yamlRoot = path.join(home, "yaml-root");
fs.writeFileSync(
  path.join(cwd, "tdai-gateway.yaml"),
  `data:\n  baseDir: ${yamlRoot}\n`,
);
process.chdir(cwd);
resetTdaiRootCacheForTests();

const scratchDir = path.join(home, "scratch-run");
fs.mkdirSync(path.join(scratchDir, "out"), { recursive: true });
fs.writeFileSync(
  path.join(scratchDir, "out", "result.json"),
  "{ broken",
  "utf-8",
);

const cfgRoot = loadGatewayConfig().data.baseDir;
// ФАЛЬСИФИКАЦИЯ этой ноги: FALSIFY=metadata-default — отдать дефолтный корень,
// как было до фикса. Лог уедет мимо конфига, обе проверки покраснеют.
const parsed = await readScratchDiff(
  scratchDir,
  MISSED_META ? defaultTdaiRoot() : cfgRoot,
);
const metaLog = resolveUnderRoot(cfgRoot, ".metadata", "diff-malformed.log");
const strayLog = resolveUnderRoot(
  defaultTdaiRoot(),
  ".metadata",
  "diff-malformed.log",
);
console.log(`  корень из yaml:  ${cfgRoot}`);
console.log(`  лог метаданных:  ${metaLog} → ${fs.existsSync(metaLog)}`);
console.log(`  мимо конфига:    ${strayLog} → ${fs.existsSync(strayLog)}`);
must("сломанный кандидат распознан", parsed.error !== undefined);
must("лог метаданных лёг под корень из yaml", fs.existsSync(metaLog));
must("и ничего не легло под дефолтный корень", !fs.existsSync(strayLog));

process.chdir(os.tmpdir());
fs.rmSync(home, { recursive: true, force: true });

finish();
