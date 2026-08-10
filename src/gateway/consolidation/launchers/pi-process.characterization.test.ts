/**
 * tz-06 Ф0 → Ф2: те же три свойства, теперь с ПЕРЕВЁРНУТЫМ ожиданием.
 *
 * Ф0 зафиксировала, как было (коммит 917c0e9): результат приходил на `exit`,
 * поздний вывод терялся, stdout копился без границы. Ф2 меняет ровно эти
 * строки:
 *   1. форма аргументов — по-прежнему здесь, внутри launchers/ (критерий 1);
 *   2. терминальный результат — только после `close` и reap, поэтому вывод,
 *      напечатанный потомком уже после смерти ребёнка, ПОПАДАЕТ в результат
 *      (L7, критерий 7);
 *   3. в памяти живёт только хвост, полный поток — в artifacts/ (критерий 8).
 *
 * Ребёнок — /bin/sh, никакой pi-сессии не запускается.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runKeeperProcess } from "./pi-process.js";
import { OUTPUT_TAIL_BYTES } from "./output-spool.js";
import type { Logger } from "../../../core/types.js";

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("keeper-run: сегодняшнее поведение (tz-06 Ф0)", () => {
  let dir: string;

  const script = (name: string, body: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o755 });
    return file;
  };

  const run = (flags: string[], extra?: string[], timeoutMs = 10_000) =>
    runKeeperProcess({
      piBinary: "/bin/sh",
      spawnFlags: flags,
      extraArgs: extra,
      model: "m1",
      thinking: "low",
      systemPromptPath: "/tmp/sys.md",
      taskPrompt: "do the thing",
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs,
      logger: silent,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-char-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("аргументы: spawnFlags, extraArgs, затем --model/--thinking/--system-prompt и задание", async () => {
    const echo = script("echo-args.sh", 'for a in "$@"; do echo "$a"; done\n');

    const res = await run([echo], ["--extension", "/x/ext"]);

    // Первый аргумент — сам скрипт: он пришёл из spawnFlags, то есть форма
    // вызова целиком собирается в keeper-run, а не в launcher'е.
    expect(res.stdout.split("\n").filter(Boolean)).toEqual([
      "--extension",
      "/x/ext",
      "--model",
      "m1",
      "--thinking",
      "low",
      "--system-prompt",
      "/tmp/sys.md",
      "do the thing",
    ]);
    expect(res.exitCode).toBe(0);
  });

  it("результат приходит после close: поздний вывод потомка ПОПАДАЕТ в него", async () => {
    const late = script(
      "late.sh",
      "( sleep 0.4; echo LATE-CHILD-OUTPUT ) &\necho EARLY\nexit 0\n",
    );

    const res = await run([late]);

    expect(res.stdout).toContain("EARLY");
    // Потомок пережил ребёнка и держал трубу открытой — ждём `close`, поэтому
    // его вывод больше не теряется.
    expect(res.stdout).toContain("LATE-CHILD-OUTPUT");
  });

  it("таймаут: результат всё равно приходит после reap, с killed и timedOut", async () => {
    const hang = script("hang.sh", "trap '' TERM\necho STARTED\nsleep 30\n");

    const res = await run([hang], undefined, 300);

    expect(res.timedOut).toBe(true);
    expect(res.killed).not.toBeNull();
    // Вывод, успевший до убийства, доезжает — результат собран после reap.
    expect(res.stdout).toContain("STARTED");
  });

  it("stdout ограничен: в памяти хвост, весь поток — в artifacts/", async () => {
    const lines = 1024;
    const width = 1023; // + \n = 1 КиБ на строку
    const big = script(
      "big.sh",
      `i=0\nwhile [ $i -lt ${lines} ]; do\n  printf '%0${width}d\\n' $i\n  i=$((i+1))\ndone\n`,
    );

    const res = await run([big]);

    const produced = lines * (width + 1); // 1 МиБ
    expect(res.stdoutBytes).toBe(produced);
    expect(res.stdout.length).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES);
    // Хвост, а не начало: ошибка ребёнка всегда в конце.
    expect(
      res.stdout.endsWith(String(lines - 1).padStart(width, "0") + "\n"),
    ).toBe(true);
    const spooled = fs.statSync(res.stdoutFile!).size;
    expect(spooled).toBe(produced);
  });
});
