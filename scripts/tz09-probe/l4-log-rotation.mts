/**
 * tz-log Ф4 — ротация сохраняет историю, а не стирает её.
 *
 * `gateway-dev.log` набрал 27 МБ за один день, а ротацией было усечение в
 * ноль на 50 МБ: в момент перехода порога пропадала вся история, по которой
 * и восстанавливают, что случилось с прогоном. Теперь файл переезжает в
 * `.1`/`.2`, а старший поколение удаляется.
 *
 * Вторая нога — про гонку: записи идут fire-and-forget, и без сериализации
 * два параллельных писателя, увидев размер выше порога, переименуют файл
 * дважды, и `.1` (свежая история) потеряется.
 *
 * FALSIFY=truncate — дофиксовое поведение: усечение в ноль вместо переезда.
 * Обе ноги обязаны стать ложными.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDevLogger, flushLogs } from "../../src/utils/dev-logger.js";
import { must, finish } from "../tz07-probe/assert.mts";

const TRUNCATE = process.env.FALSIFY === "truncate";
const MAX_BYTES = 2_000;
const FIRST = "ПЕРВАЯ-СТРОКА-ИСТОРИИ";
/** Чуть больше одного порога: ровно один переезд. */
const LINES_ONE_ROTATION = 20;
/** Много и параллельно: проверка, что переезд не размножается. */
const LINES_RACE = 200;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz-log-rot-"));
const file = path.join(dir, "gateway-dev.log");

const logger = createDevLogger({
  tag: "[probe]",
  logFile: file,
  maxBytes: MAX_BYTES,
});

logger.info(FIRST);
await flushLogs();

if (TRUNCATE) {
  // Дофиксовая ротация: перешагнув порог, файл обнулялся на месте.
  const before = fs.readFileSync(file, "utf-8");
  fs.writeFileSync(file, before.repeat(80));
  fs.writeFileSync(file, "");
  logger.info("после усечения");
  await flushLogs();
} else {
  // Ровно один переезд: первая строка обязана оказаться в `.1`.
  for (let i = 0; i < LINES_ONE_ROTATION; i++) {
    logger.info(`строка ${i} ${"x".repeat(120)}`);
  }
  await flushLogs();
}

const historyAfterFirst = fs.existsSync(`${file}.1`)
  ? fs.readFileSync(`${file}.1`, "utf-8")
  : "";
const liveAfterFirst = fs.readFileSync(file, "utf-8");
console.log(
  `после одного переезда: .1 = ${historyAfterFirst.length} байт, ` +
    `живой = ${liveAfterFirst.length} байт`,
);
must(
  "первая строка пережила ротацию",
  historyAfterFirst.includes(FIRST) || liveAfterFirst.includes(FIRST),
);

// Гонка: fire-and-forget записи, у сериализованной очереди переезд не
// размножается и `.1` остаётся непустой историей.
if (!TRUNCATE) {
  await Promise.all(
    Array.from({ length: LINES_RACE }, (_, i) =>
      Promise.resolve().then(() => {
        logger.info(`гонка ${i} ${"x".repeat(120)}`);
      }),
    ),
  );
  await flushLogs();
}

const generations = fs.readdirSync(dir).sort();
console.log(`поколения: ${generations.join(", ")}`);
const history = fs.existsSync(`${file}.1`)
  ? fs.readFileSync(`${file}.1`, "utf-8")
  : "";
console.log(`после гонки: .1 = ${history.length} байт`);
must(
  "история осталась в `.1`, а поколений не больше двух",
  history !== "" &&
    !fs.existsSync(`${file}.3`) &&
    generations.filter((f) => /\.\d+$/.test(f)).length <= 2,
);

fs.rmSync(dir, { recursive: true, force: true });
finish();
