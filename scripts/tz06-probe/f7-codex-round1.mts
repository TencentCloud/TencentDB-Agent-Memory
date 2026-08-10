/**
 * tz-06: живая проверка фиксов по замечаниям Codex (раунд 1).
 *
 * Каждый блок — то, что фейковые хосты предыдущих проб пропустили:
 *   #5  дефолтные флаги хоста доезжают до РЕАЛЬНОГО argv при конфиге без
 *       flags (иначе claude ушёл бы в интерактив, а codex мимо `exec`);
 *   #5b codex не получает свою внутреннюю (здесь нерабочую) песочницу и
 *       видит auth оператора через CODEX_HOME;
 *   #10 bare-имя бинаря (`sh` на PATH) резолвится ДО построения bind-списка,
 *       иначе внутри namespace его нет;
 *   #6  cancelAndWait даёт terminal status `cancelled`, а не безликий failed,
 *       и spool-файлы доезжают до потребителя.
 *
 * ФАЛЬСИФИКАЦИИ: FALSIFY=empty-flags — конфиг задаёт flags: [] явно; это НЕ
 * «дай дефолты», и argv обязан остаться без них.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClaudeLauncher } from "../../src/gateway/consolidation/launchers/claude.js";
import {
  createCodexLauncher,
  operatorCodexHome,
} from "../../src/gateway/consolidation/launchers/codex.js";
import {
  confineArgv,
  resolveExecutable,
} from "../../src/gateway/consolidation/launchers/isolation.js";
import type { ResolvedRoleContract } from "../../src/gateway/consolidation/role-contract-types.js";
import type { Logger } from "../../src/core/types.js";

const EMPTY = process.env.FALSIFY === "empty-flags";
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-f7-"));
const argvDump = path.join(root, "argv.txt");
const host = path.join(root, "host.sh");
fs.writeFileSync(
  host,
  `#!/bin/sh
: > "${argvDump}"
for a in "$@"; do printf '%s\\n' "$a" >> "${argvDump}"; done
exit 0
`,
  { mode: 0o755 },
);

const contract = {
  binding: { launcherId: "x", model: "test-model", thinking: "low" },
  assets: {},
  timeoutMs: 15_000,
  // Роль объявляет свои python-хелперы — ровно тот вход, который раньше
  // уезжал claude'у в --allowedTools как список тулов хоста.
  toolsSubset: new Set(["fetch_records.py"]),
  requiresCapabilities: [],
} as unknown as ResolvedRoleContract;

function inputAt(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  const promptPath = path.join(cwd, "prompt.md");
  fs.writeFileSync(promptPath, "SYSTEM");
  return {
    runId: randomUUID(),
    attemptId: randomUUID(),
    cwd,
    promptPath,
    taskPrompt: "TASK",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
    contract,
  };
}

// Конфиг БЕЗ flags — ровно то, что напишет оператор, добавляя второй хост.
const settings = EMPTY ? { binary: host, flags: [] } : { binary: host };

for (const [name, make] of [
  ["claude", createClaudeLauncher],
  ["codex", createCodexLauncher],
] as const) {
  const out = await make(settings, silent).launch(
    inputAt(path.join(root, name)) as never,
  );
  if (!out.ok) throw new Error(`${name}: ${out.error.kind}`);
  await out.handle.completion;
  const argv = fs.readFileSync(argvDump, "utf-8").split("\n").filter(Boolean);
  console.log(`${name} argv[0..1] = ${JSON.stringify(argv.slice(0, 2))}`);
  console.log(
    `  дефолты хоста в argv: ${
      name === "claude" ? argv.includes("-p") : argv.includes("exec")
    }`,
  );
  if (name === "claude") {
    const at = argv.indexOf("--permission-mode");
    console.log(
      `  режим прав ребёнка: ${at < 0 ? "НЕ ЗАДАН (дефолт не даст записать кандидат)" : argv[at + 1]}`,
    );
    console.log(
      `  имена python-файлов в --allowedTools: ${argv.includes("--allowedTools")}`,
    );
  }
  if (name === "codex") {
    const at = argv.indexOf("-s");
    console.log(
      `  режим шелла ребёнка: ${at < 0 ? "НЕ ЗАДАН (дефолт read-only — роль не запишет кандидат)" : argv[at + 1]}`,
    );
    const linked = fs.existsSync(path.join(out.handle.sessionRef, "auth.json"));
    console.log(
      `  auth оператора виден в CODEX_HOME попытки: ${linked} ` +
        `(источник ${operatorCodexHome()})`,
    );
  }
}

// #10 — bare-имя резолвится до bind-списка. Берём НАСТОЯЩИЙ случай: `pi`
// лежит в ~/.bun/bin, то есть вне /usr, и без резолва внутрь namespace не
// попадает вовсе.
for (const name of ["pi", "sh"]) {
  const resolved = resolveExecutable(name);
  if (resolved === null) {
    console.log(`bare "${name}": не найден на PATH — пропуск`);
    continue;
  }
  const bare = confineArgv(root, name, ["-c", "true"]);
  const dir = path.dirname(resolved);
  const underRo = dir === "/usr" || dir.startsWith("/usr/");
  const bound = bare.args.includes(dir) || underRo;
  console.log(
    `bare "${name}" → ${resolved}; в argv путь: ${bare.args.includes(resolved)}; ` +
      `достижим внутри namespace: ${bound}` +
      `${underRo ? " (уже под /usr)" : " (добавлен bind)"}`,
  );
}

// #6 — cancel имеет собственный terminal status, spool доезжает.
const hang = path.join(root, "hang.sh");
fs.writeFileSync(hang, "#!/bin/sh\necho ping\ntrap '' TERM\nsleep 30\n", {
  mode: 0o755,
});
const c = await createClaudeLauncher({ binary: hang }, silent).launch(
  inputAt(path.join(root, "cancel")) as never,
);
if (!c.ok) throw new Error("cancel: launch refused");
const first = await c.handle.cancelAndWait();
const second = await c.handle.cancelAndWait();
console.log(`cancel status = ${first.status} (ожидается cancelled)`);
console.log(`повторный cancel даёт то же: ${first.status === second.status}`);
console.log(
  `spool-ссылка на полный stdout: ${first.stdoutFile !== null && first.stdoutFile !== undefined}`,
);

fs.rmSync(root, { recursive: true, force: true });
