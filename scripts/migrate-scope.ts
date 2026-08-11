/**
 * tz-05 Ф8 — scope migration for records written before the attribute existed.
 *
 * Tier-3 by the repo's risk table: it mutates stored data. Therefore the
 * default is a DRY RUN that prints the distribution and changes nothing, and
 * `--apply` additionally REQUIRES `--default-scope`, so the value assigned to
 * scope-less records is chosen from the printed report rather than guessed in
 * advance.
 *
 * Rollback carrier (ТЗ :149): every touched record's previous scope and
 * project_id go into `<dataDir>/.metadata/scope-migration/<timestamp>.jsonl`
 * BEFORE the update runs. No new column and no new table — the crystal forbids
 * both. Replaying that file backwards is the rollback, and reading it forwards
 * is what makes a second run a no-op (ТЗ :132).
 *
 * Usage:
 *   npx tsx scripts/migrate-scope.ts                          # dry run, live root
 *   npx tsx scripts/migrate-scope.ts --db /path/vectors.db    # dry run, given db
 *   npx tsx scripts/migrate-scope.ts --apply --default-scope global
 *   npx tsx scripts/migrate-scope.ts --apply --default-scope project --project-id /repo/x
 *   npx tsx scripts/migrate-scope.ts --rollback <journal.jsonl>
 */
import fs from "node:fs";
import path from "node:path";
import { openWritableSqlite } from "../src/gateway/http-utils.js";
import { loadGatewayConfig } from "../src/gateway/config.js";

interface Args {
  db?: string;
  dataDir?: string;
  apply: boolean;
  defaultScope?: string;
  projectId?: string;
  rollback?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--apply") args.apply = true;
    else if (flag === "--db") ((args.db = value), (i += 1));
    else if (flag === "--data-dir") ((args.dataDir = value), (i += 1));
    else if (flag === "--default-scope")
      ((args.defaultScope = value), (i += 1));
    else if (flag === "--project-id") ((args.projectId = value), (i += 1));
    else if (flag === "--rollback") ((args.rollback = value), (i += 1));
  }
  return args;
}

interface JournalLine {
  record_id: string;
  scope_before: string | null;
  project_id_before: string | null;
  scope_after: string;
  /** Written since the `project` scope carries an id; absent in older journals. */
  project_id_after?: string;
}

/** Records the migration would touch: no scope, or an empty one. */
const SELECT_UNSET =
  "SELECT record_id, scope, project_id FROM l1_records " +
  "WHERE scope IS NULL OR TRIM(COALESCE(scope, '')) = ''";

const DISTRIBUTION =
  "SELECT COALESCE(scope, '(null)') AS scope, " +
  "CASE WHEN COALESCE(project_id, '') = '' THEN 'empty' ELSE 'set' END AS project_id, " +
  "COUNT(*) AS n FROM l1_records GROUP BY 1, 2 ORDER BY n DESC";

function journalDir(dataDir: string): string {
  return path.join(dataDir, ".metadata", "scope-migration");
}

/**
 * Suffix a rolled-back journal carries.
 *
 * `alreadyMigrated` only reads `.jsonl`, so renaming is what makes a rollback
 * actually undo the run: the ids stop counting as done and `--apply` migrates
 * them again. Renaming rather than deleting, because the file is also the only
 * record that the run ever happened.
 */
const ROLLED_BACK_SUFFIX = ".rolledback";

/** Every record id any previous run already touched and did not roll back. */
function alreadyMigrated(dataDir: string): Set<string> {
  const done = new Set<string>();
  let files: string[];
  try {
    files = fs
      .readdirSync(journalDir(dataDir))
      .filter((f) => f.endsWith(".jsonl"));
  } catch {
    return done;
  }
  for (const file of files) {
    const raw = fs.readFileSync(path.join(journalDir(dataDir), file), "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        done.add((JSON.parse(line) as JournalLine).record_id);
      } catch {
        // A truncated last line (killed mid-write) is not a reason to refuse
        // the whole journal — the record it names simply gets migrated again,
        // which is safe: the second write sets the same value.
      }
    }
  }
  return done;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // Resolving through the gateway's own loader, not defaultTdaiRoot(): a
  // yaml-relocated install would otherwise silently migrate an empty DB.
  // Static import, not require(): this file IS the ESM entry point, and a
  // require() here crashed the documented no-arg run outright. The backend
  // always comes from the config — it decides whether an in-place migration
  // is possible at all, and no flag can override that truthfully.
  const gateway = loadGatewayConfig();
  const backend = gateway.memory.storeBackend;
  const dataDir =
    args.dataDir ?? (args.db ? path.dirname(args.db) : gateway.data.baseDir);
  const dbPath = args.db ?? path.join(dataDir, "vectors.db");
  console.log(`[scope-migration] db: ${dbPath}`);
  if (!fs.existsSync(dbPath)) {
    // A missing DB is an addressing mistake, not a crash: the resolved root is
    // the thing worth printing, since that is what the user got wrong.
    console.error(
      `[scope-migration] базы нет по этому пути — проверь корень (data.baseDir / TDAI_DATA_DIR) или передай --db`,
    );
    process.exitCode = 2;
    return;
  }
  console.log(`[scope-migration] journal dir: ${journalDir(dataDir)}`);

  const db = openWritableSqlite(dbPath);
  try {
    if (args.rollback) {
      rollback(db, args.rollback);
      return;
    }

    console.log("[scope-migration] распределение записей:");
    for (const row of db.prepare(DISTRIBUTION).all() as Array<
      Record<string, unknown>
    >) {
      console.log(
        `  scope=${String(row.scope)} project_id=${String(row.project_id)} → ${String(row.n)}`,
      );
    }

    const done = alreadyMigrated(dataDir);
    const candidates = (
      db.prepare(SELECT_UNSET).all() as Array<Record<string, unknown>>
    ).filter((row) => !done.has(String(row.record_id)));
    console.log(
      `[scope-migration] без scope: ${candidates.length} (уже мигрировано ранее: ${done.size})`,
    );

    if (!args.apply) {
      console.log(
        "[scope-migration] DRY RUN — ничего не изменено. " +
          "Для запуска: --apply --default-scope <global|project> " +
          "(значение выбирается по распределению выше, а не заранее).",
      );
      return;
    }

    // The TCVDB carrier cannot be migrated in place: its documents predate the
    // fields AND the collection predates their filter indexes, and TCVDB can
    // add neither. The procedure is the one the store warns about at startup.
    if (backend === "tcvdb") {
      console.error(
        "[scope-migration] бэкенд tcvdb: миграция на месте невозможна. " +
          "Порядок: выгрузить коллекцию, удалить её, перезапустить плагин " +
          "(коллекция пересоздастся с filter-индексами на scope/project_id), " +
          "залить документы обратно. До этого режим strict на tcvdb включать нельзя.",
      );
      process.exitCode = 2;
      return;
    }

    const scope = args.defaultScope;
    if (scope !== "global" && scope !== "project") {
      console.error(
        "[scope-migration] --apply требует --default-scope global|project",
      );
      process.exitCode = 2;
      return;
    }
    // scope=project without a project id is worse than no migration at all:
    // `passesScope` drops such a record in hidden AND in strict, so choosing
    // `project` from the report would quietly delete every legacy memory from
    // recall in every mode. The two columns move together or not at all.
    const projectId = args.projectId ?? "";
    if (scope === "project" && !projectId) {
      console.error(
        "[scope-migration] --default-scope project требует --project-id <id>: " +
          "запись со scope=project и пустым project_id не видна ни в одном режиме",
      );
      process.exitCode = 2;
      return;
    }
    if (candidates.length === 0) {
      console.log("[scope-migration] нечего мигрировать — повторный прогон.");
      return;
    }

    // Журнал пишется ДО обновления: если процесс умрёт между ними, останется
    // запись «что было», а не молча изменённые данные без пути назад.
    fs.mkdirSync(journalDir(dataDir), { recursive: true });
    const journalPath = path.join(
      journalDir(dataDir),
      `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
    );
    const lines = candidates.map((row) =>
      JSON.stringify({
        record_id: String(row.record_id),
        scope_before: row.scope === null ? null : String(row.scope),
        project_id_before:
          row.project_id === null ? null : String(row.project_id),
        scope_after: scope,
        // What the UPDATE below actually writes: a global record keeps the
        // project it was captured in, so claiming "" here would be a lie in
        // the one file the operator reads to understand the run.
        project_id_after:
          scope === "project" ? projectId : String(row.project_id ?? ""),
      } satisfies JournalLine),
    );
    fs.writeFileSync(journalPath, `${lines.join("\n")}\n`, "utf-8");
    console.log(`[scope-migration] журнал отката: ${journalPath}`);

    const update = db.prepare(
      "UPDATE l1_records SET scope = ?, project_id = ? WHERE record_id = ?",
    );
    for (const row of candidates)
      update.run(
        scope,
        // A global record keeps whatever project it was captured in; only the
        // `project` scope is a statement about ownership.
        scope === "project" ? projectId : String(row.project_id ?? ""),
        String(row.record_id),
      );
    console.log(`[scope-migration] обновлено записей: ${candidates.length}`);
  } finally {
    db.close();
  }
}

/** Replay a journal backwards: every record gets its previous scope again. */
function rollback(
  db: ReturnType<typeof openWritableSqlite>,
  journalPath: string,
): void {
  if (!fs.existsSync(journalPath)) {
    // Almost always a journal that was already rolled back: say so, instead of
    // an ENOENT stack over a path that does exist under another name.
    const retired = `${journalPath}${ROLLED_BACK_SUFFIX}`;
    console.error(
      fs.existsSync(retired)
        ? `[scope-migration] журнал уже откатан ранее: ${retired}`
        : `[scope-migration] журнала нет по этому пути: ${journalPath}`,
    );
    process.exitCode = 2;
    return;
  }
  const raw = fs.readFileSync(journalPath, "utf-8");
  const update = db.prepare(
    "UPDATE l1_records SET scope = ?, project_id = ? WHERE record_id = ?",
  );
  let restored = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as JournalLine;
    // project_id goes back too: the migration may have written it, so restoring
    // scope alone would leave the record half rolled back.
    update.run(entry.scope_before, entry.project_id_before, entry.record_id);
    restored += 1;
  }
  // Undoing the run means undoing its claim on those ids, otherwise the next
  // --apply reports "нечего мигрировать" over records that need migrating.
  const retired = `${journalPath}${ROLLED_BACK_SUFFIX}`;
  fs.renameSync(journalPath, retired);
  console.log(
    `[scope-migration] откат по журналу ${journalPath}: ${restored} записей`,
  );
  console.log(
    `[scope-migration] журнал помечен откатанным: ${retired} — эти записи снова доступны для --apply`,
  );
}

main();
