/**
 * tz-06 critic r3 [high] artifact-ref-collision: две попытки одного run'а
 * делят ОДИН scratch (keeper и его критик — `runner.ts` и `critic-launch.ts`
 * обе передают `cwd: args.scratchDir`), а спул открывался как
 * `<cwd>/artifacts/stdout.log` с флагом "a". Итог: обе строки attempts
 * указывали на один файл, и «полный вывод по artifact ref» отдавал склейку
 * двух ролей.
 *
 * Проба гоняет два attempt'а в общем cwd и печатает их stdoutFile и
 * (размер файла vs собственные stdoutBytes попытки).
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=shared-root — спулить в cwd, как до фикса.
 * Пути обязаны совпасть, а размер файла — разъехаться с stdoutBytes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runChildProcess } from "../../src/gateway/consolidation/launchers/child-process.js";
import { attemptDir } from "../../src/gateway/consolidation/launchers/start.js";
import type { LaunchInput } from "../../src/gateway/consolidation/launchers/types.js";
import type { Logger } from "../../src/core/types.js";

const SHARED = process.env.FALSIFY === "shared-root";
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tz06-f10-"));
const runId = randomUUID();
// Один scratch на run — ровно как у keeper'а и его критика.
const cwd = path.join(root, "runs", runId);
fs.mkdirSync(cwd, { recursive: true });

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"} cwd=${cwd}`);

const rows: { role: string; file: string; bytes: number; size: number }[] = [];
for (const [role, line] of [
  ["keeper", "KEEPER_OUTPUT"],
  ["critic", "CRITIC_OUTPUT"],
] as const) {
  const input = { runId, attemptId: `att-${role}`, cwd } as LaunchInput;
  const res = await runChildProcess({
    binary: "/bin/sh",
    args: ["-c", `printf '%s\\n' ${line}`],
    cwd,
    artifactRoot: SHARED ? cwd : attemptDir(input),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    timeoutMs: 10_000,
    logger: silent,
  });
  const file = res.stdoutFile ?? "";
  rows.push({
    role,
    file,
    bytes: res.stdoutBytes ?? 0,
    size: file === "" ? -1 : fs.statSync(file).size,
  });
}

for (const r of rows) {
  console.log(
    `${r.role}: stdoutFile=${r.file.replace(cwd, "<cwd>")} ` +
      `stdoutBytes=${r.bytes} размер файла=${r.size} ` +
      `совпало=${r.bytes === r.size}`,
  );
}
const distinct = rows[0].file !== rows[1].file;
console.log(`пути попыток различны: ${distinct} (должно быть true)`);
console.log(
  `у каждой попытки в файле ровно её вывод: ` +
    `${rows.every((r) => r.bytes === r.size)} (должно быть true)`,
);

fs.rmSync(root, { recursive: true, force: true });
