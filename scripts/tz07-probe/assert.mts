/**
 * Общий выход для проб tz-07.
 *
 * Проба, которая печатает «должно быть true» и всегда выходит с нулём, — это
 * отчёт, а не проверка: в CI и в глазах читателя она неотличима от успешной.
 * Каждое наблюдение регистрируется здесь, и процесс падает, если хоть одно
 * оказалось ложным.
 */
const observations: Array<[string, boolean]> = [];

/** Записать наблюдение и напечатать его в едином формате. */
export function must(label: string, value: boolean): boolean {
  observations.push([label, value]);
  console.log(`${label}: ${value} (должно быть true)`);
  return value;
}

/** Напечатать итог и выйти с ненулевым кодом, если что-то ложно. */
export function finish(): void {
  const failed = observations.filter(([, v]) => !v);
  if (failed.length === 0) {
    console.log(`ИТОГ: все ${observations.length} наблюдений верны`);
    return;
  }
  console.log(
    `ИТОГ: ложных наблюдений ${failed.length} из ${observations.length} — ${failed
      .map(([l]) => l)
      .join("; ")}`,
  );
  process.exitCode = 1;
}
