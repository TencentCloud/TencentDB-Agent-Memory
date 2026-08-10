/**
 * tz-06 Ф3 живая проба: сессия НА ПОПЫТКУ, на настоящем процессе.
 *
 * Фейковый хост читает свой `--session-dir` из argv и дописывает туда
 * `messages.log` со своим id сообщения — ровно то, что делает pi с
 * транскриптом. Две попытки одного рана запускаются подряд.
 *
 * Проверяется: (а) каталоги сессий двух попыток различаются; (б) ни в один
 * каталог не затекли чужие message id; (в) sessionRef указывает на реальный
 * каталог внутри attempts/<attemptId>/.
 *
 * ФАЛЬСИФИКАЦИИ:
 *   FALSIFY=same-dir   — выдать обеим попыткам ОДИН attemptId → утечка id.
 *   FALSIFY=no-session — вернуть `--no-session` в фиксированные флаги
 *                        конфига → stripOwnedFlags обязан его снять,
 *                        сессия остаётся.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createPiLauncher } from "../../src/gateway/consolidation/launchers/pi.js";
import type { ResolvedRoleContract } from "../../src/gateway/consolidation/role-contract-types.js";
import type { Logger } from "../../src/core/types.js";

const MODE = process.env.FALSIFY ?? "";
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-f3-"));
const host = path.join(root, "fake-host.sh");
fs.writeFileSync(
  host,
  `#!/bin/sh
# Фейковый pi: находит свой --session-dir и пишет туда транскрипт.
dir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--session-dir" ]; then dir="$a"; fi
  # Настоящий pi при --no-session транскрипта не пишет; фейк падает, чтобы
  # непроглоченный флаг было видно, а не молча терялось.
  if [ "$a" = "--no-session" ]; then echo "--no-session survived" >&2; exit 4; fi
  prev="$a"
done
[ -n "$dir" ] || { echo "no --session-dir" >&2; exit 3; }
echo "msg-$TZ06_MSG_ID" >> "$dir/messages.log"
exit 0
`,
  { mode: 0o755 },
);

const contract = {
  binding: { launcherId: "pi", model: "m", thinking: "low" },
  assets: {},
  timeoutMs: 20_000,
} as unknown as ResolvedRoleContract;

const flags =
  MODE === "no-session"
    ? ["-p", "--no-context-files", "--no-session"]
    : ["-p", "--no-context-files"];
const launcher = createPiLauncher({ binary: host, flags }, silent);

const runId = randomUUID();
const cwd = path.join(root, "runs", runId);
fs.mkdirSync(cwd, { recursive: true });
const promptPath = path.join(cwd, "prompt.md");
fs.writeFileSync(promptPath, "sys");

const attemptA = randomUUID();
const attemptB = MODE === "same-dir" ? attemptA : randomUUID();

const refs: string[] = [];
for (const [i, attemptId] of [attemptA, attemptB].entries()) {
  const out = await launcher.launch({
    runId,
    attemptId,
    cwd,
    promptPath,
    taskPrompt: "task",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TZ06_MSG_ID: String(i + 1),
    },
    contract,
  });
  if (!out.ok) throw new Error(`launch refused: ${out.error.kind}`);
  const res = await out.handle.completion;
  console.log(
    `попытка ${i + 1}: status=${res.status} exit=${res.exitCode} ` +
      `sessionRef=${path.relative(cwd, out.handle.sessionRef)}`,
  );
  refs.push(out.handle.sessionRef);
}

console.log(`attempt sessions differ: ${refs[0] !== refs[1]}`);

// Утечка = в одном каталоге сессии больше одного message id.
let leaked = 0;
for (const ref of new Set(refs)) {
  const log = path.join(ref, "messages.log");
  const ids = new Set(
    fs.readFileSync(log, "utf-8").split("\n").filter(Boolean),
  );
  if (ids.size > 1) leaked += ids.size - 1;
}
console.log(`message ids leaked: ${leaked}`);
console.log(
  `сессия создана внутри attempts/: ${refs.every((r) => r.includes(`${path.sep}attempts${path.sep}`) && fs.existsSync(r))}`,
);

fs.rmSync(root, { recursive: true, force: true });
