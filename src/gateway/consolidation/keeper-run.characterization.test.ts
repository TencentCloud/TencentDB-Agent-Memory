/**
 * tz-06 Ф0 — характеризация ТЕКУЩЕГО поведения runKeeperProcess.
 *
 * Эти тесты не описывают желаемое: они фиксируют то, что есть сегодня, чтобы
 * Ф1/Ф2 переворачивали конкретные строки, а не «наверное починили». Три
 * свойства, которые пакет обязан изменить:
 *   1. форма аргументов — вся pi-специфика собрана прямо здесь (§Критерий 1);
 *   2. терминальный результат приходит на `exit`, до `close` и reap, поэтому
 *      вывод, который ребёнок (или его потомок) печатает позже, теряется
 *      (L7, критерий 7);
 *   3. stdout копится в память без границы (критерий 8).
 *
 * Ребёнок — /bin/sh, никакой pi-сессии не запускается.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runKeeperProcess } from "./keeper-run.js";
import type { Logger } from "../../core/types.js";

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

  it("результат приходит на exit: вывод, напечатанный позже, ТЕРЯЕТСЯ", async () => {
    const late = script(
      "late.sh",
      "( sleep 0.4; echo LATE-CHILD-OUTPUT ) &\necho EARLY\nexit 0\n",
    );

    const res = await run([late]);

    expect(res.stdout).toContain("EARLY");
    // Труба ещё открыта — её держит переживший родителя потомок, — но
    // промис уже разрешён на `exit`. С ожиданием `close` этот вывод бы приехал.
    expect(res.stdout).not.toContain("LATE-CHILD-OUTPUT");
  });

  it("stdout не ограничен: сколько ребёнок напечатал, столько и в памяти", async () => {
    const lines = 1024;
    const width = 1023; // + \n = 1 КиБ на строку
    const big = script(
      "big.sh",
      `i=0\nwhile [ $i -lt ${lines} ]; do\n  printf '%0${width}d\\n' $i\n  i=$((i+1))\ndone\n`,
    );

    const res = await run([big]);

    expect(res.stdout.length).toBe(lines * (width + 1));
  });
});
