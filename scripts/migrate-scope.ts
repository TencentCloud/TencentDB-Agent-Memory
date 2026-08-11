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
 *   npx tsx scripts/migrate-scope.ts --rollback <journal.jsonl>
 */
import fs from "node:fs";
import path from "node:path";
import { openWritableSqlite } from "../src/gateway/http-utils.js";

interface Args {
  db?: string;
  dataDir?: string;
  apply: boolean;
  defaultScope?: string;
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
    else if (flag === "--rollback") ((args.rollback = value), (i += 1));
  }
  return args;
}

interface JournalLine {
  record_id: string;
  scope_before: string | null;
  project_id_before: string | null;
  scope_after: string;
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

/** Every record id any previous run already touched. */
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
  let dataDir = args.dataDir;
  if (!dataDir) {
    if (args.db) dataDir = path.dirname(args.db);
    else {
      const { loadGatewayConfig } = require("../src/gateway/config.js") as {
        loadGatewayConfig: () => { data: { baseDir: string } };
      };
      dataDir = loadGatewayConfig().data.baseDir;
    }
  }
  const dbPath = args.db ?? path.join(dataDir, "vectors.db");
  console.log(`[scope-migration] db: ${dbPath}`);
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

    const scope = args.defaultScope;
    if (scope !== "global" && scope !== "project") {
      console.error(
        "[scope-migration] --apply требует --default-scope global|project",
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
      } satisfies JournalLine),
    );
    fs.writeFileSync(journalPath, `${lines.join("\n")}\n`, "utf-8");
    console.log(`[scope-migration] журнал отката: ${journalPath}`);

    const update = db.prepare(
      "UPDATE l1_records SET scope = ? WHERE record_id = ?",
    );
    for (const row of candidates) update.run(scope, String(row.record_id));
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
  const raw = fs.readFileSync(journalPath, "utf-8");
  const update = db.prepare(
    "UPDATE l1_records SET scope = ? WHERE record_id = ?",
  );
  let restored = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as JournalLine;
    update.run(entry.scope_before, entry.record_id);
    restored += 1;
  }
  console.log(
    `[scope-migration] откат по журналу ${journalPath}: ${restored} записей`,
  );
}

main();
