/**
 * tz-06 critic r3 [medium] secret-in-child-workspace: `linkIdentity` кладёт
 * симлинк на РЕАЛЬНЫЙ `.credentials.json` оператора внутрь
 * `<cwd>/attempts/<id>/session`, то есть внутрь рабочего каталога, куда
 * ребёнок пишет. Гипотеза критика: ребёнок может прочитать секрет и —
 * хуже — переписать его ЧЕРЕЗ симлинк, испортив логин оператора. Это прямо
 * противоречит инварианту `nogo-secrets`.
 *
 * Проба безопасна: «дом оператора» — фейковый каталог с канарейкой, реальный
 * ~/.claude не участвует (CLAUDE_CONFIG_DIR переопределён).
 *
 * Роль играет фейковый claude-бинарь, который делает ровно две вещи:
 * читает секрет и пишет в него.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=symlink — проба сама кладёт в сессию симлинк (как
 * было до фикса), и `provideIdentity` его не трогает, потому что файл уже
 * есть. Секрет оператора обязан оказаться перезаписан: это доказывает, что
 * защищает именно копия, а не что-то ещё.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClaudeLauncher } from "../../src/gateway/consolidation/launchers/claude.js";
import type { ResolvedRoleContract } from "../../src/gateway/consolidation/role-contract-types.js";
import type { Logger } from "../../src/core/types.js";

const FALSIFY = process.env.FALSIFY ?? "(нет)";
const CANARY = "CANARY-SECRET-DO-NOT-LEAK";
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-f11-"));
const fakeHome = path.join(root, "fake-operator-home");
fs.mkdirSync(fakeHome, { recursive: true });
fs.writeFileSync(path.join(fakeHome, ".credentials.json"), CANARY);
process.env.CLAUDE_CONFIG_DIR = fakeHome;

// Роль: прочитать секрет и переписать его через ссылку.
const fakeClaude = path.join(root, "fake-claude.sh");
fs.writeFileSync(
  fakeClaude,
  `#!/bin/sh
printf 'ЧИТАЮ: '
cat "$CLAUDE_CONFIG_DIR/.credentials.json" 2>&1 || printf '<не смог>'
printf '\\n'
printf 'PWNED-BY-CHILD' > "$CLAUDE_CONFIG_DIR/.credentials.json" 2>&1 \\
  && printf 'ЗАПИСЬ: удалась\\n' || printf 'ЗАПИСЬ: отказано\\n'
exit 0
`,
  { mode: 0o755 },
);

const cwd = path.join(root, "scratch");
fs.mkdirSync(cwd, { recursive: true });
const sessionDir = path.join(cwd, "attempts", "att-1", "session");
if (process.env.FALSIFY === "symlink") {
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.symlinkSync(
    path.join(fakeHome, ".credentials.json"),
    path.join(sessionDir, ".credentials.json"),
  );
}
fs.writeFileSync(path.join(cwd, "prompt.md"), "SYSTEM PROMPT");

const launcher = createClaudeLauncher(
  { binary: fakeClaude, flags: ["-p"] },
  silent,
);
const outcome = await launcher.launch({
  runId: randomUUID(),
  attemptId: "att-1",
  cwd,
  promptPath: path.join(cwd, "prompt.md"),
  taskPrompt: "TASK",
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
  contract: {
    binding: { launcherId: "claude", model: "m", thinking: "low" },
    assets: {},
    timeoutMs: 20_000,
    toolsSubset: null,
    requiresCapabilities: [],
  } as unknown as ResolvedRoleContract,
});
if (!outcome.ok) throw new Error(`launch отказал: ${outcome.error.message}`);
const res = await outcome.handle.completion;
console.log(`FALSIFY=${FALSIFY}`);
console.log(res.stdout.trim());

const after = fs.readFileSync(
  path.join(fakeHome, ".credentials.json"),
  "utf-8",
);
console.log(`секрет оператора после прогона: ${after}`);
console.log(`секрет прочитан ребёнком: ${res.stdout.includes(CANARY)}`);
console.log(
  `секрет оператора ПЕРЕЗАПИСАН ребёнком: ${after !== CANARY} ` +
    `(должно быть false)`,
);
console.log(
  `копия удалена после прогона: ` +
    `${!fs.existsSync(path.join(sessionDir, ".credentials.json"))} ` +
    `(должно быть true)`,
);

fs.rmSync(root, { recursive: true, force: true });
