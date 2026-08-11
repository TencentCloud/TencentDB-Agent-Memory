/**
 * tz-07 Ф5, критерий 4 / инвариант `nogo-secrets`: окружение ребёнка — это
 * whitelist, и ни одно его ЗНАЧЕНИЕ не совпадает с содержимым auth-файла или
 * loopback-токена.
 *
 * Спека (S3) прямо говорит: «whitelist есть» — regression-guard, а не
 * доказательство. Доказательная часть — снять ФАКТИЧЕСКОЕ окружение под
 * не-pi launcher'ом. Поэтому здесь строится настоящий env через
 * buildChildEnv, а поверх — то, что добавляет claude-launcher
 * (CLAUDE_CONFIG_DIR на каталог попытки).
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=leak-key — положить секрет в env так, как это
 * сделал бы «безобидный» новый ключ в whitelist'е. Проба обязана краснеть на
 * ОБОИХ хостах; если она этого не делает, она не смотрит на значения и
 * первая половина ничего не значит. Whitelist при этом НЕ изменяется — утечка
 * моделируется в самой пробе и живёт ровно один прогон.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildChildEnv } from "../../src/gateway/consolidation/child-spawn.js";
import { authRootFor } from "../../src/gateway/consolidation/launchers/auth-root.js";

const LEAK = process.env.FALSIFY === "leak-key";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz07-p5-"));
process.env.HOME = home;

// Секреты, которых ребёнок не должен увидеть ни под каким именем.
const AUTH_SECRET = "sk-ant-oat01-PROBE-SECRET-VALUE-do-not-leak";
const LOOPBACK_TOKEN = "loopback-PROBE-TOKEN-3f9a2c";

const claudeHome = path.join(home, ".claude");
fs.mkdirSync(claudeHome, { recursive: true });
fs.writeFileSync(
  path.join(claudeHome, ".credentials.json"),
  JSON.stringify({ claudeAiOauth: { accessToken: AUTH_SECRET } }),
  "utf-8",
);

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
console.log(`claude auth-root: ${authRootFor("claude")}`);

const attemptSession = path.join(home, "scratch", "attempt-1", "session");
fs.mkdirSync(attemptSession, { recursive: true });

function childEnvFor(launcherId: string): Record<string, string> {
  const base = buildChildEnv({
    pathValue: process.env.PATH ?? "",
    home,
    runUuid: "run-probe",
    gatewayUrl: "http://127.0.0.1:8765",
    ownerPid: process.pid,
  });
  // То, что launcher добавляет поверх базового whitelist'а.
  const perHost: Record<string, string> =
    launcherId === "claude"
      ? { CLAUDE_CONFIG_DIR: attemptSession }
      : launcherId === "codex"
        ? { CODEX_HOME: attemptSession }
        : {};
  const leaked: Record<string, string> = LEAK
    ? { ANTHROPIC_API_KEY: AUTH_SECRET, TDAI_MEMORY_TOKEN: LOOPBACK_TOKEN }
    : {};
  return { ...base, ...perHost, ...leaked };
}

const authFileBody = fs.readFileSync(
  path.join(claudeHome, ".credentials.json"),
  "utf-8",
);
const secrets = [AUTH_SECRET, LOOPBACK_TOKEN];

let anyLeak = false;
for (const id of ["pi", "claude", "codex"]) {
  const env = childEnvFor(id);
  const hits: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (secrets.some((s) => v.includes(s))) hits.push(`${k}=<секрет>`);
    // Значение, целиком лежащее внутри auth-файла, — тоже утечка: ключ мог
    // приехать под именем, которого нет в списке secrets.
    else if (v.length >= 16 && authFileBody.includes(v))
      hits.push(`${k}=<из auth-файла>`);
  }
  if (hits.length > 0) anyLeak = true;
  console.log(
    `  ${id.padEnd(7)} ключей: ${Object.keys(env).length}, совпадений с секретами: ${hits.length}${hits.length ? ` — ${hits.join(", ")}` : ""}`,
  );
}

console.log(`ни одно значение не совпало: ${!anyLeak} (должно быть true)`);
console.log(
  `состав env под claude: ${Object.keys(childEnvFor("claude")).sort().join(", ")}`,
);

fs.rmSync(home, { recursive: true, force: true });
