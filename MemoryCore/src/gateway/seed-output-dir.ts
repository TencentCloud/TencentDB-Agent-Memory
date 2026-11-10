import { randomUUID } from "node:crypto";

/**
 * Unique output dir for one /seed run:
 * `<baseDir>/seed-<YYYYMMDD>-<HHMMSS>-<8 hex chars>`.
 *
 * The timestamp keeps dirs sortable and human-readable; the uuid suffix
 * prevents two seeds launched within the same second from colliding on
 * the same output / checkpoint files.
 */
export function makeSeedOutputDir(baseDir: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${baseDir}/seed-${ts}-${randomUUID().slice(0, 8)}`;
}
