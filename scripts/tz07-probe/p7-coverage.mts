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
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRoleDir } from "../../src/gateway/role-paths.js";
import { resolveUnderRoot } from "../../src/gateway/tdai-root.js";
import { resolveLogFile } from "../../src/utils/dev-logger.js";
import { hostTaskRoots } from "../../src/gateway/consolidation/launchers/auth-root.js";

const MISSED = process.env.FALSIFY === "one-site-missed";

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
if (strays.length > 0) console.log(`промахнулись: ${strays.join("; ")}`);

// Старый корень обязан остаться пустым — S1: успех «по новому пути» ничего не
// значит, если часть данных продолжает капать в старый.
const legacyLeftovers = fs.existsSync(legacyRoot)
  ? fs.readdirSync(legacyRoot)
  : [];
console.log(
  `под СТАРЫМ корнем ничего не появилось: ${legacyLeftovers.length === 0} (должно быть true)` +
    (legacyLeftovers.length ? ` — ${legacyLeftovers.join(", ")}` : ""),
);

// inspectable-run: корень задач хоста — тоже не под памятью.
console.log(`корни задач хоста (pi): ${hostTaskRoots(["pi"]).join(", ")}`);

fs.rmSync(home, { recursive: true, force: true });
