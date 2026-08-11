/**
 * tz-03b Ф6/S4 — список деградаций не декоративен (ТЗ критерий 5 :91, S4 :126).
 *
 * Contract-тест гоняет ОДИН набор проверок против настоящего
 * `SqliteMemoryStore` и настоящего `TcvdbMemoryStore` (последний — через
 * локальный HTTP-фейк API, поэтому под тестом код `tcvdb.ts`, а не заглушка,
 * написанная с ним соглашаться).
 *
 * Проба запускает этот тест трижды: начисто он обязан пройти, а с каждой из
 * двух фальсификаций списка — упасть. Если список декоративен, тест пройдёт во
 * всех трёх прогонах, и проба это увидит.
 *
 * ФАЛЬСИФИКАЦИИ передаются внутрь vitest:
 *   FALSIFY=drop-degradation — из списка убрана РЕАЛЬНАЯ разница (ftsSearch).
 *   FALSIFY=fake-degradation — в список добавлена НЕСУЩЕСТВУЮЩАЯ разница.
 */
import { spawnSync } from "node:child_process";
import { must, finish } from "../tz07-probe/assert.mts";

function runContract(falsify: string): number {
  const res = spawnSync(
    "npx",
    ["vitest", "run", "src/core/store/contract.test.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, FALSIFY: falsify },
      encoding: "utf-8",
    },
  );
  const tail = (res.stdout ?? "")
    .split("\n")
    .filter((l) => /Tests|Test Files/.test(l))
    .join(" | ");
  console.log(`  FALSIFY=${falsify || "(нет)"} → exit=${res.status} ${tail}`);
  return res.status ?? 1;
}

const clean = runContract("");
must("contract-тест проходит на обоих бэкендах начисто", clean === 0);

const dropped = runContract("drop-degradation");
must("убрали реальную деградацию из списка — тест УПАЛ", dropped !== 0);

const faked = runContract("fake-degradation");
must("заявили несуществующую деградацию — тест тоже УПАЛ", faked !== 0);

finish();
