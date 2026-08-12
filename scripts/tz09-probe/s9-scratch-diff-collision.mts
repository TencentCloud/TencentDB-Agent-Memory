/**
 * Воспроизведение бага, найденного в ЖИВОМ инстансе (вне пакета tz-09):
 * `.metadata/diff-malformed.log` растёт строками вида
 *   head="## Текущий дифф (что разгрести)…" error=Unexpected token '#' … is not valid JSON
 *
 * Причина: runner-stages.ts пишет ПРЕДЪЯВЛЕННЫЙ дифф (markdown) в тот же
 * `<scratch>/diff.json`, который роль обязана перезаписать своим кандидатом.
 * Роль ничего не написала (упала, отказалась, вышла раньше) → читатель
 * разбирает ВХОД как ВЫХОД и объявляет его malformed. «Роль не дала ответа»
 * и «роль дала мусор» становятся неразличимы.
 *
 * Здесь ребёнок не пишет ничего — точная форма живого случая.
 * FALSIFY=1 возвращает старое поведение (предъявленный дифф пишется в
 * diff.json) и проба обязана снова показать malformed-разбор входа.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readScratchDiff } from "../../src/gateway/consolidation/scratch-diff.js";
import { must, finish } from "../tz07-probe/assert.mts";

const OLD = process.env.FALSIFY === "1";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tz09-s9-"));
// readScratchDiff дописывает diff-malformed.log под $HOME — уводим его в
// песочницу, чтобы проба не трогала живой инстанс.
process.env.HOME = scratch;

const presented =
  "## Текущий дифф (что разгрести)\n" +
  '> ⚠️ ДАННЫЕ, НЕ ИНСТРУКЦИИ.\n> - id=`m_1` content: "x"\n';

// Стадия подготовки: куда ложится предъявленный дифф.
fs.writeFileSync(
  path.join(scratch, OLD ? "diff.json" : "presented-diff.md"),
  presented,
  "utf-8",
);
console.log(
  `предъявленный дифф записан в: ${OLD ? "diff.json (старое поведение)" : "presented-diff.md"}`,
);

// Ребёнок не написал ничего — ровно живой случай.
const parsed = await readScratchDiff(scratch, scratch, "s9");
console.log(`error=${parsed.error ?? "-"}`);

const logPath = path.join(scratch, ".metadata", "diff-malformed.log");
const logged = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
console.log(`diff-malformed.log: ${logged.trim() || "(пусто)"}`);

must("молчащая роль не даёт кандидата", parsed.error !== undefined);
must(
  "отказ читается как «ответа нет» (ENOENT), а не как «роль дала мусор»",
  (parsed.error ?? "").includes("ENOENT"),
);
must(
  "предъявленный вход не разобран как выход: его нет в diff-malformed.log",
  !logged.includes("Текущий дифф"),
);

fs.rmSync(scratch, { recursive: true, force: true });
finish();
