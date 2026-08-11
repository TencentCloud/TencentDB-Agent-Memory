/**
 * tz-07 Ф7, S5 — «единственная форма проверки, которую нельзя пройти
 * формально»: сделать старый корень НЕДОСТУПНЫМ ДЛЯ ЗАПИСИ и прогнать цикл.
 * Любое забытое место проявится отказом записи, а не молчаливым расщеплением.
 *
 * Порядок важен. Сначала под `~/.pi` кладутся настоящие файлы и доказывается,
 * что после `chmod a-w` запись туда ДЕЙСТВИТЕЛЬНО падает: на пустом или
 * отсутствующем каталоге проба прошла бы тривиально и ничего бы не значила.
 * Только потом гоняется цикл.
 *
 * Две ветки корня, потому что задаётся он по-разному (кристалл §1b):
 *   standalone — TDAI_DATA_DIR → loadGatewayConfig;
 *   openclaw   — dataDir инжектируется хостом (index.ts:248-249), parseConfig
 *                не участвует; здесь она эмулируется явной передачей корня
 *                тем же резолверам, которым его отдаёт host-adapter.
 *
 * ФАЛЬСИФИКАЦИЯ: FALSIFY=legacy-write — заставить одно место писать в старый
 * корень. Цикл обязан упасть с EACCES; если он проходит, замок не заперт и
 * зелёная нога ничего не доказывает.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCleanup } from "../../src/gateway/cleanup.js";
import { resolveRoleDir } from "../../src/gateway/role-paths.js";
import {
  resetTdaiRootCacheForTests,
  resolveUnderRoot,
} from "../../src/gateway/tdai-root.js";
import {
  createDevLogger,
  flushLogs,
  resolveLogFile,
} from "../../src/utils/dev-logger.js";
import { readScratchDiff } from "../../src/gateway/consolidation/scratch-diff.js";
import type { Logger } from "../../src/core/types.js";
import { must, finish } from "./assert.mts";
import { createHash } from "node:crypto";

/** Хэш дерева: путь + размер + mtime каждого файла, рекурсивно. */
function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        h.update(`d:${p}`);
        walk(p);
      } else {
        const st = fs.statSync(p);
        h.update(`f:${p}:${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return h.digest("hex").slice(0, 16);
}

const LEGACY_WRITE = process.env.FALSIFY === "legacy-write";

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

async function cycle(branch: "standalone" | "openclaw"): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `tz07-p7c-${branch}-`));
  process.env.HOME = home;
  const legacyRoot = path.join(home, ".pi", "agent-memory", "tdai");
  const root = path.join(home, "new-root");
  fs.mkdirSync(path.join(legacyRoot, "roles", "memory-keeper"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(legacyRoot, "roles", "memory-keeper", "prompt.md"),
    "старый промпт\n",
    "utf-8",
  );
  fs.mkdirSync(root, { recursive: true });
  // Уборке нужно, ЧТО удалять, иначе её нога зелена по бездействию: под замком
  // ей просто не за что взяться. Устаревший прогон кладём в оба дерева.
  const stale = Date.now() / 1000 - 30 * 24 * 3600;
  for (const base of [root, legacyRoot]) {
    const old = path.join(base, "scratch", "run-old");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "diff.json"), "{}", "utf-8");
    fs.utimesSync(path.join(old, "diff.json"), stale, stale);
    fs.utimesSync(old, stale, stale);
  }

  // Ветка standalone задаёт корень через env; openclaw — только явной
  // передачей, как это делает host-adapter с инжектированным pluginDataDir.
  if (branch === "standalone") process.env.TDAI_DATA_DIR = root;
  else delete process.env.TDAI_DATA_DIR;
  resetTdaiRootCacheForTests();

  // --- Замок и доказательство, что он заперт ---------------------------------
  const piRoot = path.join(home, ".pi");
  // Файлы тоже: запись в СУЩЕСТВУЮЩИЙ файл требует прав на файл, а не на его
  // каталог, — замок только из каталогов оставлял бы дыру, через которую
  // фальсификация проходила бы зелёной.
  fs.chmodSync(
    path.join(legacyRoot, "roles", "memory-keeper", "prompt.md"),
    0o444,
  );
  fs.chmodSync(path.join(legacyRoot, "roles", "memory-keeper"), 0o555);
  fs.chmodSync(path.join(legacyRoot, "roles"), 0o555);
  // Замок накрывает и scratch: иначе уборка сносит старый прогон, и премисса
  // «старый корень нельзя писать» держится только на половине дерева.
  fs.chmodSync(path.join(legacyRoot, "scratch", "run-old"), 0o555);
  fs.chmodSync(path.join(legacyRoot, "scratch"), 0o555);
  fs.chmodSync(legacyRoot, 0o555);
  fs.chmodSync(path.join(home, ".pi", "agent-memory"), 0o555);
  fs.chmodSync(piRoot, 0o555);

  let lockHolds = false;
  try {
    fs.writeFileSync(path.join(legacyRoot, "canary.txt"), "x");
  } catch {
    lockHolds = true;
  }
  must(`[${branch}] запись в старый корень падает`, lockHolds);
  if (!lockHolds) {
    console.log(`[${branch}] ЗАМОК НЕ ЗАПЕРТ — дальше мерить нечего`);
    fs.chmodSync(piRoot, 0o755);
    fs.rmSync(home, { recursive: true, force: true });
    return;
  }

  // --- Полный цикл -----------------------------------------------------------
  // Снимок СТАРОГО дерева: замок доказывает, что запись падает, а хэш — что
  // ни один шаг не изменил там ни байта (S5 целиком, а не только отказы).
  const before = treeHash(legacyRoot);
  const failures: string[] = [];
  /**
   * Два шага цикла пишут через best-effort-код, который глотает EACCES
   * (scratch-diff.ts и dev-logger). Для них «не бросило» ничего не значит —
   * судить можно только по тому, ГДЕ файл оказался. Раунд 6: без этой проверки
   * ноги «лог» и «метаданные» были декорацией, и S5 держался на одной ноге.
   */
  const landed = (file: string): void => {
    if (!fs.existsSync(file)) {
      throw new Error(`файл не появился под новым корнем (${file})`);
    }
  };
  const step = async (name: string, fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message.slice(0, 80)}`);
    }
  };

  // 1. Резолв роли: читает СТАРЫЙ путь (fallback) — чтение под замком законно.
  await step("резолв роли", () => {
    const dir = LEGACY_WRITE
      ? path.join(legacyRoot, "roles")
      : resolveRoleDir(root);
    // 2. Запись промпта — то, что делает установка/синк роли.
    fs.mkdirSync(path.join(dir, "memory-keeper"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "memory-keeper", "prompt.md"),
      "новый промпт\n",
      "utf-8",
    );
  });

  // 3. Логи.
  await step("лог", async () => {
    const logger = createDevLogger({
      tag: "[p7c]",
      dev: true,
      logDir: LEGACY_WRITE
        ? path.join(legacyRoot, "logs")
        : resolveUnderRoot(root, "logs"),
    });
    logger.info("цикл пошёл");
    await flushLogs();
    landed(resolveLogFile(resolveUnderRoot(root, "logs")));
  });

  // 4. Метаданные: путь битого результата (тот самый лог из scratch-diff).
  await step("метаданные", async () => {
    const scratch = path.join(root, "scratch", "run-1");
    fs.mkdirSync(path.join(scratch, "out"), { recursive: true });
    fs.writeFileSync(
      path.join(scratch, "out", "result.json"),
      "{ битый",
      "utf-8",
    );
    await readScratchDiff(scratch, LEGACY_WRITE ? legacyRoot : root, "run-1");
    landed(resolveUnderRoot(root, ".metadata", "diff-malformed.log"));
  });

  // 5. Уборка. runCleanup НЕ бросает: EACCES складывается в stats.errors, —
  // поэтому судить о ней по «не бросило» было той же декорацией, что и ноги 3-4
  // (раунд 7). Судим по возвращаемому значению.
  await step("уборка", async () => {
    const stats = await runCleanup({
      dataDir: LEGACY_WRITE ? legacyRoot : root,
      scratchRoot: path.join(LEGACY_WRITE ? legacyRoot : root, "scratch"),
      hostTaskRoots: [],
      home,
      sessionRetentionHours: 336,
      config: { enabled: true, intervalHours: 24, paths: [] },
      now: () => Date.now(),
      logger: silent,
    });
    if (stats.errors.length > 0) {
      throw new Error(`уборка отчиталась об отказах: ${stats.errors[0]}`);
    }
  });

  if (failures.length > 0) console.log(`  ${failures.join("\n  ")}`);
  must(`[${branch}] цикл без отказов доступа`, failures.length === 0);
  must(
    `[${branch}] старое дерево не изменилось`,
    treeHash(legacyRoot) === before,
  );

  fs.chmodSync(piRoot, 0o755);
  fs.chmodSync(path.join(home, ".pi", "agent-memory"), 0o755);
  fs.chmodSync(legacyRoot, 0o755);
  fs.chmodSync(path.join(legacyRoot, "scratch"), 0o755);
  fs.chmodSync(path.join(legacyRoot, "scratch", "run-old"), 0o755);
  fs.chmodSync(path.join(legacyRoot, "roles"), 0o755);
  fs.chmodSync(path.join(legacyRoot, "roles", "memory-keeper"), 0o755);
  fs.chmodSync(
    path.join(legacyRoot, "roles", "memory-keeper", "prompt.md"),
    0o644,
  );
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`FALSIFY=${process.env.FALSIFY ?? "(нет)"}`);
await cycle("standalone");
await cycle("openclaw");

finish();
