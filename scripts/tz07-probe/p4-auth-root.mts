/**
 * tz-07 Ф4, критерий 5: auth-root резолвится ПО LAUNCHER'У, и у не-pi хоста
 * путь отличается.
 *
 * Заодно вторая половина Q2: корень задач — хостовый, а не памяти. У pi он
 * есть, у claude/codex его нет вовсе, и «no-op» выражается пустым списком, а
 * не веткой внутри уборки.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=single-root — вернуть всем `$HOME`, как было до
 * пакета. Три пути обязаны совпасть, а `hostTaskRoots` — начать выдавать
 * корень для каждого хоста; если и тогда проба зелёная, она не смотрит на то,
 * что называет.
 */
import os from "node:os";
import path from "node:path";
import {
  authRootFor,
  hostTaskRootFor,
  hostTaskRoots,
} from "../../src/gateway/consolidation/launchers/auth-root.js";

const SINGLE = process.env.FALSIFY === "single-root";
const IDS = ["pi", "claude", "codex"];

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);

// Хост без переменных: дефолты обязаны разойтись сами по себе.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
const home = process.env.HOME ?? os.homedir();

const roots = IDS.map((id) => (SINGLE ? home : authRootFor(id)));
for (const [i, id] of IDS.entries()) {
  console.log(`  ${id.padEnd(7)} auth-root: ${roots[i]}`);
}
const distinct = new Set(roots).size === IDS.length;
const nonPiDiffers = roots[1] !== roots[0] && roots[2] !== roots[0];
console.log(`все различны:            ${distinct} (должно быть true)`);
console.log(`у не-pi путь отличается: ${nonPiDiffers} (должно быть true)`);

// Переменная окружения перебивает дефолт — иначе H3 не переключаем.
process.env.CODEX_HOME = path.join(os.tmpdir(), "tz07-codex-home");
const overridden = SINGLE ? home : authRootFor("codex");
console.log(
  `CODEX_HOME перебивает дефолт: ${overridden === path.join(os.tmpdir(), "tz07-codex-home")} (должно быть true)`,
);

// Q2: корень задач есть только у pi.
const taskRoots = SINGLE
  ? IDS.map((id) => path.join(authRootFor(id), ".pi", "agent", "tasks"))
  : hostTaskRoots(IDS);
console.log(`корней задач на три хоста: ${taskRoots.length} (должно быть 1)`);
console.log(`  ${taskRoots.join("\n  ")}`);
console.log(
  `claude/codex не дают корня: ${
    SINGLE
      ? false
      : hostTaskRootFor("claude") === null && hostTaskRootFor("codex") === null
  } (должно быть true)`,
);
