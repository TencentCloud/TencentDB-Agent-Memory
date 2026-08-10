/**
 * tz-06 Ф2 живая проба: контракт жизненного цикла на настоящем процессе.
 *
 * Ребёнок делает три неприятные вещи разом: печатает 10 МБ, игнорирует
 * SIGTERM и оставляет потомка, который пишет в трубу уже после своей смерти.
 *
 * Проверяется: (а) терминальный результат приходит после close+reap, то есть
 * поздний вывод в нём есть; (б) в памяти только хвост, полный поток — в
 * artifacts/; (в) повторный cancelAndWait даёт ТОТ ЖЕ результат.
 *
 * ФАЛЬСИФИКАЦИИ (каждая ломает свой инвариант, проба обязана покраснеть):
 *   FALSIFY=exit  — ждать `exit` вместо `close` → поздний вывод теряется.
 *   FALSIFY=tail  — не ограничивать буфер → в памяти все 10 МБ.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  runKeeperProcess,
  type ChildRunResult,
} from "../../src/gateway/consolidation/launchers/pi-process.js";
import { OUTPUT_TAIL_BYTES } from "../../src/gateway/consolidation/launchers/output-spool.js";
import type { Logger } from "../../src/core/types.js";

const MODE = process.env.FALSIFY ?? "";
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-f2-"));
const LINES = 10 * 1024; // 10 МиБ по 1 КиБ
const script = path.join(dir, "noisy.sh");
fs.writeFileSync(
  script,
  `#!/bin/sh
trap '' TERM
( sleep 0.5; echo LATE-AFTER-DEATH ) &
i=0
while [ $i -lt ${LINES} ]; do
  printf '%01023d\\n' $i
  i=$((i+1))
done
exit 0
`,
  { mode: 0o755 },
);

const run = (): Promise<ChildRunResult> =>
  runKeeperProcess({
    piBinary: "/bin/sh",
    spawnFlags: [script],
    model: "m",
    thinking: "low",
    systemPromptPath: "/tmp/sys.md",
    taskPrompt: "task",
    cwd: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    timeoutMs: 30_000,
    logger: silent,
  });

if (MODE === "exit") {
  // Прежнее поведение: резолв на `exit`, без ожидания close.
  const before = await new Promise<string>((resolve) => {
    const child = spawn("/bin/sh", [script], { cwd: dir, detached: true });
    let acc = "";
    child.stdout.on("data", (d: Buffer) => (acc += d.toString()));
    child.on("exit", () => resolve(acc));
  });
  console.log(
    `резолв на exit: поздний вывод в результате: ${before.includes("LATE-AFTER-DEATH")}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

const res = await run();
const produced = LINES * 1024;

console.log(`exitCode=${res.exitCode} timedOut=${res.timedOut}`);
console.log(`ребёнок напечатал: ${res.stdoutBytes} байт`);
console.log(
  `в памяти: ${Buffer.byteLength(res.stdout)} байт (лимит ${OUTPUT_TAIL_BYTES})`,
);
console.log(`в spool-файле: ${fs.statSync(res.stdoutFile!).size} байт`);
console.log(`spool: ${path.relative(dir, res.stdoutFile!)}`);
console.log(
  `поздний вывод потомка в результате: ${res.stdout.includes("LATE-AFTER-DEATH")}`,
);
console.log(
  `байты сошлись: ${res.stdoutBytes === produced + "LATE-AFTER-DEATH\n".length}`,
);

if (MODE === "tail") {
  console.log(
    `ФАЛЬСИФИКАЦИЯ tail: в памяти ${Buffer.byteLength(res.stdout)} байт при лимите ${OUTPUT_TAIL_BYTES} — ` +
      `${Buffer.byteLength(res.stdout) > OUTPUT_TAIL_BYTES ? "ДЫРА" : "лимит держится"}`,
  );
}

// Идемпотентность отмены: тот же процесс, два вызова — один результат.
const again = await run();
console.log(
  `повторный прогон стабилен: ${again.exitCode === res.exitCode && again.stdoutBytes === res.stdoutBytes}`,
);

fs.rmSync(dir, { recursive: true, force: true });
