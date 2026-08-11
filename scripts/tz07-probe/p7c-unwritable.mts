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
import { createDevLogger, flushLogs } from "../../src/utils/dev-logger.js";
import { readScratchDiff } from "../../src/gateway/consolidation/scratch-diff.js";
import type { Logger } from "../../src/core/types.js";

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
  fs.chmodSync(legacyRoot, 0o555);
  fs.chmodSync(path.join(home, ".pi", "agent-memory"), 0o555);
  fs.chmodSync(piRoot, 0o555);

  let lockHolds = false;
  try {
    fs.writeFileSync(path.join(legacyRoot, "canary.txt"), "x");
  } catch {
    lockHolds = true;
  }
  console.log(
    `[${branch}] запись в старый корень падает: ${lockHolds} (должно быть true)`,
  );
  if (!lockHolds) {
    console.log(`[${branch}] ЗАМОК НЕ ЗАПЕРТ — дальше мерить нечего`);
    fs.chmodSync(piRoot, 0o755);
    fs.rmSync(home, { recursive: true, force: true });
    return;
  }

  // --- Полный цикл -----------------------------------------------------------
  const failures: string[] = [];
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
    await readScratchDiff(scratch, "run-1");
  });

  // 5. Уборка.
  await step("уборка", () =>
    runCleanup({
      dataDir: root,
      scratchRoot: path.join(root, "scratch"),
      hostTaskRoots: [],
      home,
      sessionRetentionHours: 336,
      config: { enabled: true, intervalHours: 24, paths: [] },
      now: () => Date.now(),
      logger: silent,
    }),
  );

  console.log(
    `[${branch}] цикл без отказов доступа: ${failures.length === 0} (должно быть true)` +
      (failures.length ? `\n  ${failures.join("\n  ")}` : ""),
  );

  fs.chmodSync(piRoot, 0o755);
  fs.chmodSync(path.join(home, ".pi", "agent-memory"), 0o755);
  fs.chmodSync(legacyRoot, 0o755);
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
