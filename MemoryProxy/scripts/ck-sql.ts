/**
 * 读取文本文件里的 SQL 并在 ClickHouse 上逐条执行。
 *
 * 连接参数（url / user / password / database）用服务自己的 `buildConfig` 解析，
 * 和代理进程读同一份 config.yaml、同一套默认值，保证连的是同一个 CK。
 *
 * 用法：
 *   npx tsx scripts/ck-sql.ts <file.sql> [选项]
 *   echo "SELECT 1" | npx tsx scripts/ck-sql.ts - [选项]
 *
 * 选项：
 *   --config <path>   配置文件，默认 MemoryProxy/config.yaml
 *   --write           允许写操作（INSERT / ALTER / DROP …）；默认只读
 *   --json            结果按 JSON 输出（默认对齐表格）
 *   --max-rows <n>    每条语句最多打印的行数，默认 200
 *   --continue        某条语句出错后继续执行后面的
 *
 * 文件格式：多条语句用 `;` 分隔；支持 `--` 行注释和块注释；字符串 / 反引号 /
 * 双引号里的 `;` 不会被当作分隔符。
 *
 * 安全：默认以 readonly=2 执行（服务端拒绝一切写操作，但允许改查询级设置），
 * 加 --write 才去掉这一限制。密码只从配置读取，不会打印。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { buildConfig } from "../src/config.js";

interface Options {
  file: string;
  configFile: string;
  write: boolean;
  json: boolean;
  maxRows: number;
  keepGoing: boolean;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage(code: number): never {
  const out = code === 0 ? console.log : console.error;
  out(
    "用法: npx tsx scripts/ck-sql.ts <file.sql|-> [--config path] [--write] [--json] [--max-rows n] [--continue]",
  );
  process.exit(code);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    file: "",
    configFile: resolve(ROOT, "config.yaml"),
    write: false,
    json: false,
    maxRows: 200,
    keepGoing: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        usage(0);
      case "--config":
        opts.configFile = resolve(argv[++i] ?? usage(1));
        break;
      case "--write":
        opts.write = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--max-rows": {
        const n = Number(argv[++i]);
        if (!Number.isInteger(n) || n <= 0) usage(1);
        opts.maxRows = n;
        break;
      }
      case "--continue":
        opts.keepGoing = true;
        break;
      default:
        if (arg.startsWith("--") || opts.file) usage(1);
        opts.file = arg;
    }
  }
  if (!opts.file) usage(1);
  return opts;
}

/**
 * 按 `;` 切分语句，跳过注释和引号内的内容。返回去掉首尾空白、非空的语句。
 * 注释原样保留在语句里，由 ClickHouse 忽略。
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === ch) {
          // SQL 风格的双写转义：'it''s'
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      buf += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ";") {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter((s) => stripComments(s).trim() !== "");
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 会返回结果集的语句走 query，其余走 command。 */
const RESULT_KEYWORDS = new Set(["SELECT", "WITH", "SHOW", "DESC", "DESCRIBE", "EXPLAIN", "EXISTS"]);

function returnsRows(sql: string): boolean {
  const first = stripComments(sql).trim().replace(/^\(+/, "").split(/\s+/, 1)[0] ?? "";
  return RESULT_KEYWORDS.has(first.toUpperCase());
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function printTable(columns: string[], rows: unknown[][]): void {
  const text = rows.map((r) => r.map(cell));
  const widths = columns.map((c, i) =>
    Math.min(80, Math.max(c.length, ...text.map((r) => r[i]!.length))),
  );
  const fmt = (vals: string[]) =>
    vals.map((v, i) => (v.length > widths[i]! ? `${v.slice(0, widths[i]! - 1)}…` : v.padEnd(widths[i]!))).join(" | ");
  console.log(fmt(columns));
  console.log(widths.map((w) => "-".repeat(w)).join("-+-"));
  for (const r of text) console.log(fmt(r));
}

async function runOne(ch: ClickHouseClient, sql: string, opts: Options): Promise<void> {
  const settings = opts.write ? {} : { readonly: "2" as const };
  const started = Date.now();
  if (!returnsRows(sql)) {
    await ch.command({ query: sql, clickhouse_settings: { ...settings, wait_end_of_query: 1 } });
    console.log(`OK (${Date.now() - started} ms)`);
    return;
  }
  const rs = await ch.query({ query: sql, format: "JSONCompactEachRowWithNames", clickhouse_settings: settings });
  const all = (await rs.json()) as unknown[][];
  const [columns = [], ...rows] = all as [string[], ...unknown[][]];
  const shown = rows.slice(0, opts.maxRows);
  if (opts.json) {
    console.log(JSON.stringify(shown.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2));
  } else {
    printTable(columns, shown);
  }
  const more = rows.length > shown.length ? `，只显示前 ${shown.length} 行` : "";
  console.log(`(${rows.length} 行${more}，${Date.now() - started} ms)`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const sqlText = readFileSync(opts.file === "-" ? 0 : resolve(opts.file), "utf8");
  const statements = splitStatements(sqlText);
  if (statements.length === 0) {
    console.error("没有可执行的 SQL");
    process.exit(1);
  }

  const cfg = buildConfig({ configFile: opts.configFile }, { strict: true }).clickhouse;
  if (!cfg.url) {
    console.error(`配置 ${opts.configFile} 里没有 clickhouse.url`);
    process.exit(1);
  }
  const ch = createClient({
    url: cfg.url,
    username: cfg.user,
    password: cfg.password,
    database: cfg.database,
    request_timeout: 120_000,
    // 长查询期间定期回传进度头，避免中间代理按空闲连接断开。
    clickhouse_settings: { send_progress_in_http_headers: 1, http_headers_progress_interval_ms: "10000" },
  });
  console.log(
    `# CK ${cfg.url}  database=${cfg.database}  user=${cfg.user}  mode=${opts.write ? "读写" : "只读"}  语句数=${statements.length}`,
  );

  let failed = 0;
  try {
    for (const [i, sql] of statements.entries()) {
      const preview = stripComments(sql).replace(/\s+/g, " ").trim();
      console.log(`\n-- [${i + 1}/${statements.length}] ${preview.length > 160 ? `${preview.slice(0, 160)}…` : preview}`);
      try {
        await runOne(ch, sql, opts);
      } catch (err: unknown) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`ERROR: ${msg.split("\n")[0]}`);
        if (!opts.write && /readonly/i.test(msg)) console.error("提示：写操作需要加 --write");
        if (!opts.keepGoing) break;
      }
    }
  } finally {
    await ch.close();
  }
  if (failed > 0) process.exit(2);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
