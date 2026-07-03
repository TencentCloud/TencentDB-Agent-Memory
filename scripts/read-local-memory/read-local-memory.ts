#!/usr/bin/env npx tsx
/**
 * -- Memory ------
 *
 * -- memory-tdai --------，--：
 *   - ---（L0~L3）--
 *   - L0/L1 - SQLite（vectors.db）--
 *   - ------（--since / --until）
 *   - ----（--filter，--- SQLite -----）
 *   - --、--（--- SQL -）
 *   - ------（table / json / jsonl）
 *
 * @example
 *   npx tsx read-local-memory.ts -d ./memory-tdai----
 *   npx tsx read-local-memory.ts -d ./memory-tdai---- -L L0 --since 7d
 *   npx tsx read-local-memory.ts -d ./memory-tdai---- -L L1 -f 'type=persona'
 */

import { createRequire } from "node:module"
import type { DatabaseSync } from "node:sqlite"
import * as fs from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

const require = createRequire(import.meta.url)

function requireNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite")
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

type Level = "L0" | "L1" | "L2" | "L3"
type SortDirection = "asc" | "desc"
type OutputFormat = "table" | "json" | "jsonl"

interface CliOptions {
  dataDir: string
  level?: Level
  since?: string
  until?: string
  limit: number
  offset: number
  sort: SortDirection
  filter?: string
  format: OutputFormat
  file?: string  // L2 -------：-----，-----------
}

interface FilterCondition {
  field: string
  operator: "=" | "!=" | ">=" | "<=" | ">" | "<"
  value: string
}

interface L2Meta {
  created: string
  updated: string
  summary: string
  heat: number
  [key: string]: string | number
}

interface L2Entry {
  fileName: string
  meta: L2Meta
  body: string
}

interface QueryResult<T> {
  level: string
  total: number
  offset: number
  limit: number
  sort: SortDirection
  filter: Record<string, string> | null
  data: T[]
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const SQLITE_DB_NAME = "vectors.db"

const LEVEL_DIRS: Record<string, string> = {
  L2: "scene_blocks",
  L3: "persona.md",
}

/** L0 -------（---- SQL --） */
const L0_FILTER_COLUMNS = new Set([
  "record_id", "session_key", "session_id", "role", "message_text", "recorded_at", "timestamp",
])

/** L1 -------（---- SQL --） */
const L1_FILTER_COLUMNS = new Set([
  "record_id", "content", "type", "priority", "scene_name",
  "session_key", "session_id", "timestamp_str", "timestamp_start", "timestamp_end",
  "created_time", "updated_time", "metadata_json",
])

/** ----- → SQLite ----（-------，---- SQL --） */
const CAMEL_TO_COLUMN: Record<string, string> = {
  id: "record_id",
  recordId: "record_id",
  sessionKey: "session_key",
  sessionId: "session_id",
  messageText: "message_text",
  recordedAt: "recorded_at",
  sceneName: "scene_name",
  timestampStr: "timestamp_str",
  timestampStart: "timestamp_start",
  timestampEnd: "timestamp_end",
  createdAt: "created_time",
  updatedAt: "updated_time",
  metadataJson: "metadata_json",
}

const META_START = "-----META-START-----"
const META_END = "-----META-END-----"

const RELATIVE_TIME_RE = /^(\d+)(d|h|m|s)$/

const HELP_TEXT = `
📖  -- Memory ------（SQLite --）

Usage:
  npx tsx read-local-memory.ts -d <----> [--]

-------- vectors.db（SQLite ---），L0/L1 ------。

Options:
  -d, --data-dir <-->    -- memory-tdai ------（--，-- vectors.db）
  -L, --level <-->       ----: L0 / L1 / L2 / L3（-------）
      --since <-->       ----（ISO ---------- 7d, 24h, 30m）
      --until <-->       ----（- since --）
  -l, --limit <-->       ------（-- 50）
      --offset <-->      ----（-- 0）
      --sort <-->        --: desc（-→-）/ asc（-→-），-- desc
  -f, --filter <--->    ----，--------（- role=user, type=persona, priority>=80）
                           ---------，--------
      --format <-->      --: table / json / jsonl（-- table）
  -h, --help               ----

L0 ----: record_id, session_key, session_id, role, message_text, recorded_at, timestamp
L1 ----: record_id, content, type, priority, scene_name, session_key, session_id,
             timestamp_str, timestamp_start, timestamp_end, created_time, updated_time

Examples:
  # --------
  npx tsx read-local-memory.ts -d ./memory-tdai----

  # -- L0 - 7 ----
  npx tsx read-local-memory.ts -d ./memory-tdai---- -L L0 --since 7d

  # -- L1 --，-- persona --
  npx tsx read-local-memory.ts -d ./memory-tdai---- -L L1 -f 'type=persona'

  # L0 --：- 2 -（-- 20 -）
  npx tsx read-local-memory.ts -d ./memory-tdai---- -L L0 -l 20 --offset 20

  # - JSON ----
  npx tsx read-local-memory.ts -d ./memory-tdai---- -L L0 --since 7d --format json
`.trim()

// ─────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────

function parseCli(): CliOptions {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string", short: "d" },
      level:      { type: "string", short: "L" },
      since:      { type: "string" },
      until:      { type: "string" },
      limit:      { type: "string", short: "l" },
      offset:     { type: "string" },
      sort:       { type: "string" },
      filter:     { type: "string", short: "f" },
      format:     { type: "string" },
      file:       { type: "string" },
      help:       { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  })

  if (values.help) {
    console.log(HELP_TEXT)
    process.exit(0)
  }

  const dataDir = values["data-dir"]
  if (!dataDir) {
    console.error("❌  ------: --data-dir (-d)")
    console.error('   -- --help ----')
    process.exit(1)
  }

  const resolvedDir = path.resolve(dataDir)
  if (!fs.existsSync(resolvedDir)) {
    console.error(`❌  -------: ${resolvedDir}`)
    process.exit(1)
  }

  const level = values.level?.toUpperCase() as Level | undefined
  if (level && !["L0", "L1", "L2", "L3"].includes(level)) {
    console.error(`❌  -----: ${values.level}  （--: L0, L1, L2, L3）`)
    process.exit(1)
  }

  const sort = (values.sort?.toLowerCase() ?? "desc") as SortDirection
  if (!["asc", "desc"].includes(sort)) {
    console.error(`❌  -------: ${values.sort}  （--: asc, desc）`)
    process.exit(1)
  }

  const format = (values.format?.toLowerCase() ?? "table") as OutputFormat
  if (!["table", "json", "jsonl"].includes(format)) {
    console.error(`❌  -------: ${values.format}  （--: table, json, jsonl）`)
    process.exit(1)
  }

  const limit = values.limit ? parseInt(values.limit, 10) : 50
  const offset = values.offset ? parseInt(values.offset, 10) : 0

  if (isNaN(limit) || limit < 1) {
    console.error(`❌  --- limit: ${values.limit}`)
    process.exit(1)
  }
  if (isNaN(offset) || offset < 0) {
    console.error(`❌  --- offset: ${values.offset}`)
    process.exit(1)
  }

  return {
    dataDir: resolvedDir,
    level,
    since: values.since,
    until: values.until,
    limit,
    offset,
    sort,
    filter: values.filter,
    format,
    file: values.file,
  }
}

// ─────────────────────────────────────────────
// Time Parsing
// ─────────────────────────────────────────────

/** --------- Date --。-- ISO ---------（7d / 24h / 30m / 60s） */
function parseTimeExpr(expr: string): Date {
  const match = expr.match(RELATIVE_TIME_RE)
  if (match) {
    const [, numStr, unit] = match
    const num = parseInt(numStr, 10)
    const now = Date.now()
    const ms: Record<string, number> = {
      d: 86_400_000,
      h: 3_600_000,
      m: 60_000,
      s: 1_000,
    }
    return new Date(now - num * ms[unit])
  }

  const date = new Date(expr)
  if (isNaN(date.getTime())) {
    console.error(`❌  ------: ${expr}`)
    process.exit(1)
  }
  return date
}

/** - L0 - epoch ms - L1 - ISO -------- Date */
function toDate(value: unknown): Date | null {
  if (typeof value === "number") return new Date(value)
  if (typeof value === "string") {
    const d = new Date(value)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

// ─────────────────────────────────────────────
// Filter Parsing
// ─────────────────────────────────────────────

const FILTER_OPERATORS = [">=", "<=", "!=", ">", "<", "="] as const

/** SQL -----（!= → <> for SQLite） */
const SQL_OPERATOR_MAP: Record<string, string> = {
  "=": "=",
  "!=": "<>",
  ">=": ">=",
  "<=": "<=",
  ">": ">",
  "<": "<",
}

function parseFilterExpr(expr: string): FilterCondition[] {
  return expr.split(",").map((part) => {
    const trimmed = part.trim()
    for (const op of FILTER_OPERATORS) {
      const idx = trimmed.indexOf(op)
      if (idx > 0) {
        return {
          field: trimmed.slice(0, idx).trim(),
          operator: op as FilterCondition["operator"],
          value: trimmed.slice(idx + op.length).trim(),
        }
      }
    }
    console.error(`❌  --------: ${trimmed}`)
    process.exit(1)
  })
}

/** ------------ SQLite --（-------） */
function resolveColumnName(field: string, allowedColumns: Set<string>): string {
  // --------
  if (allowedColumns.has(field)) return field
  // ------
  const mapped = CAMEL_TO_COLUMN[field]
  if (mapped && allowedColumns.has(mapped)) return mapped
  return field // ----，-------
}

/** ---------------- */
function validateFilterColumns(conditions: FilterCondition[], allowedColumns: Set<string>, level: string): void {
  for (const c of conditions) {
    const col = resolveColumnName(c.field, allowedColumns)
    if (!allowedColumns.has(col)) {
      console.error(`❌  ${level} --------: ${c.field}`)
      console.error(`   ----: ${[...allowedColumns].join(", ")}`)
      process.exit(1)
    }
  }
}

function filtersToRecord(conditions: FilterCondition[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const c of conditions) {
    result[c.field] = `${c.operator}${c.value}`
  }
  return result
}

function filtersToDisplayString(conditions: FilterCondition[]): string {
  return conditions.map((c) => `${c.field}${c.operator}${c.value}`).join(", ")
}

// ─────────────────────────────────────────────
// SQLite Helpers
// ─────────────────────────────────────────────

/** ---- SQLite --- */
function openSqliteReadonly(dbPath: string): DatabaseSync {
  const { DatabaseSync: DbSync } = requireNodeSqlite()
  const db = new DbSync(dbPath, { open: false })
  // node:sqlite ----- readOnly --，- query_only pragma ----
  db.open()
  db.exec("PRAGMA query_only = ON")
  return db
}

interface SqlQueryResult {
  total: number
  records: Record<string, unknown>[]
}

/**
 * -- WHERE --（---- + ----），-- SQL -----。
 * ---------------，-- SQL --。
 */
function buildWhereClause(
  level: "L0" | "L1",
  sinceDate: Date | null,
  untilDate: Date | null,
  filterConditions: FilterCondition[] | null,
): { whereClause: string; params: (string | number)[] } {
  const clauses: string[] = []
  const params: (string | number)[] = []
  const allowedColumns = level === "L0" ? L0_FILTER_COLUMNS : L1_FILTER_COLUMNS

  // ----
  if (level === "L0") {
    // L0: timestamp - epoch ms (INTEGER)
    if (sinceDate) {
      clauses.push("timestamp >= ?")
      params.push(sinceDate.getTime())
    }
    if (untilDate) {
      clauses.push("timestamp <= ?")
      params.push(untilDate.getTime())
    }
  } else {
    // L1: updated_time - ISO --- (TEXT)
    if (sinceDate) {
      clauses.push("updated_time >= ?")
      params.push(sinceDate.toISOString())
    }
    if (untilDate) {
      clauses.push("updated_time <= ?")
      params.push(untilDate.toISOString())
    }
  }

  // ----
  if (filterConditions) {
    for (const c of filterConditions) {
      const col = resolveColumnName(c.field, allowedColumns)
      const sqlOp = SQL_OPERATOR_MAP[c.operator]
      clauses.push(`${col} ${sqlOp} ?`)
      // ----------------，---；------
      const numVal = Number(c.value)
      params.push(!isNaN(numVal) && c.value.trim() !== "" ? numVal : c.value)
    }
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
  return { whereClause, params }
}

/** L0 SQLite - → -------- */
function mapL0Row(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.record_id,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    role: row.role,
    content: row.message_text,
    recordedAt: row.recorded_at,
    timestamp: row.timestamp,
  }
}

/** L1 SQLite - → -------- */
function mapL1Row(row: Record<string, unknown>): Record<string, unknown> {
  const metadataRaw = row.metadata_json as string
  let metadata: unknown = {}
  try {
    metadata = metadataRaw ? JSON.parse(metadataRaw) : {}
  } catch {
    metadata = {}
  }

  const timestamps = [
    ...(new Set(
      [row.timestamp_str, row.timestamp_start, row.timestamp_end]
        .filter(Boolean) as string[]
    ))
  ]

  return {
    id: row.record_id,
    content: row.content,
    type: row.type,
    priority: row.priority,
    scene_name: row.scene_name,
    source_message_ids: [],
    metadata,
    timestamps,
    createdAt: row.created_time || "",
    updatedAt: row.updated_time || "",
    sessionKey: row.session_key || "",
    sessionId: row.session_id || "",
  }
}

function querySqlite(db: DatabaseSync, level: "L0" | "L1", opts: CliOptions): SqlQueryResult {
  const table = level === "L0" ? "l0_conversations" : "l1_records"
  const timeCol = level === "L0" ? "timestamp" : "updated_time"
  const allowedColumns = level === "L0" ? L0_FILTER_COLUMNS : L1_FILTER_COLUMNS

  const sinceDate = opts.since ? parseTimeExpr(opts.since) : null
  const untilDate = opts.until ? parseTimeExpr(opts.until) : null

  let filterConditions: FilterCondition[] | null = null
  if (opts.filter) {
    filterConditions = parseFilterExpr(opts.filter)
    validateFilterColumns(filterConditions, allowedColumns, level)
  }

  const { whereClause, params } = buildWhereClause(level, sinceDate, untilDate, filterConditions)

  // ---
  const countSql = `SELECT COUNT(*) AS cnt FROM ${table} ${whereClause}`
  const countRow = db.prepare(countSql).get(...params) as { cnt: number }
  const total = countRow.cnt

  // ---（-- + --）
  const sortDir = opts.sort === "asc" ? "ASC" : "DESC"
  const dataSql = `SELECT * FROM ${table} ${whereClause} ORDER BY ${timeCol} ${sortDir} LIMIT ? OFFSET ?`
  const dataParams: (string | number)[] = [...params, opts.limit, opts.offset]
  const rows = db.prepare(dataSql).all(...dataParams) as Record<string, unknown>[]

  // -------
  const mapFn = level === "L0" ? mapL0Row : mapL1Row
  const records = rows.map(mapFn)

  return { total, records }
}

// ─────────────────────────────────────────────
// Query: L0 / L1 (SQLite)
// ─────────────────────────────────────────────

function querySqliteLevel(db: DatabaseSync, opts: CliOptions, level: "L0" | "L1") {
  const { total, records: paged } = querySqlite(db, level, opts)

  const timeField = level === "L0" ? "timestamp" : "updatedAt"
  const levelLabel = level === "L0" ? "conversations" : "records"

  let filterConditions: FilterCondition[] | null = null
  if (opts.filter) {
    filterConditions = parseFilterExpr(opts.filter)
  }
  const filterRecord = filterConditions ? filtersToRecord(filterConditions) : null
  const filterDisplay = filterConditions ? filtersToDisplayString(filterConditions) : ""
  const sinceInfo = opts.since ? `since=${opts.since}` : ""
  const untilInfo = opts.until ? `until=${opts.until}` : ""
  const filterParts = [filterDisplay, sinceInfo, untilInfo].filter(Boolean)

  if (opts.format === "json") {
    const result: QueryResult<Record<string, unknown>> = {
      level,
      total,
      offset: opts.offset,
      limit: opts.limit,
      sort: opts.sort,
      filter: filterRecord,
      data: paged,
    }
    console.log(JSON.stringify(result))
    return
  }

  if (opts.format === "jsonl") {
    for (const record of paged) {
      console.log(JSON.stringify(record))
    }
    return
  }

  // ── table -- ──
  const rangeStart = total === 0 ? 0 : opts.offset + 1
  const rangeEnd = Math.min(opts.offset + opts.limit, total)

  console.log()
  console.log(`📊  ----：${level} ${levelLabel}（SQLite）`)
  console.log(`   ---: ${total}`)
  console.log(`   ---: ${rangeStart}-${rangeEnd} / ${total}（- ${timeField} ${opts.sort === "desc" ? "--" : "--"}）`)
  if (filterParts.length > 0) {
    console.log(`   ----: ${filterParts.join(", ")}`)
  }
  console.log()

  if (paged.length === 0) {
    console.log("   （-----）")
    console.log()
    return
  }

  if (level === "L0") {
    renderL0Table(paged)
  } else {
    renderL1Table(paged)
  }
}

/** ----------- */
function truncate(str: string, maxLen: number): string {
  if (!str) return ""
  const clean = str.replace(/\n/g, "↵").replace(/\r/g, "")
  if (clean.length <= maxLen) return clean
  return clean.slice(0, maxLen - 1) + "…"
}

/** ----------（CJK --- 2 -） */
function displayWidth(str: string): number {
  let width = 0
  for (const char of str) {
    const code = char.codePointAt(0)!
    // CJK Unified Ideographs / fullwidth / common CJK ranges
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||   // CJK --
      (code >= 0x3000 && code <= 0x303f) ||   // CJK --
      (code >= 0xff00 && code <= 0xffef) ||   // --
      (code >= 0x3400 && code <= 0x4dbf) ||   // CJK --A
      (code >= 0x20000 && code <= 0x2a6df) || // CJK --B
      (code >= 0xf900 && code <= 0xfaff)      // CJK --
    ) {
      width += 2
    } else {
      width += 1
    }
  }
  return width
}

/** -------------- */
function padEnd(str: string, targetWidth: number): string {
  const diff = targetWidth - displayWidth(str)
  return diff > 0 ? str + " ".repeat(diff) : str
}

/** ------------- */
function padCenter(str: string, targetWidth: number): string {
  const diff = targetWidth - displayWidth(str)
  if (diff <= 0) return str
  const left = Math.floor(diff / 2)
  const right = diff - left
  return " ".repeat(left) + str + " ".repeat(right)
}

/** ---- */
function printTable(headers: string[], rows: string[][], colWidths: number[]) {
  const hLine = (left: string, mid: string, right: string, fill: string) =>
    left + colWidths.map((w) => fill.repeat(w + 2)).join(mid) + right

  console.log(hLine("┌", "┬", "┐", "─"))

  const headerRow = headers.map((h, i) => ` ${padCenter(h, colWidths[i])} `).join("│")
  console.log(`│${headerRow}│`)

  console.log(hLine("├", "┼", "┤", "─"))

  for (const row of rows) {
    const line = row.map((cell, i) => ` ${padEnd(cell, colWidths[i])} `).join("│")
    console.log(`│${line}│`)
  }

  console.log(hLine("└", "┴", "┘", "─"))
}

/** ----------- */
function formatTime(value: unknown): string {
  const date = toDate(value)
  if (!date) return String(value ?? "")
  const y = date.getFullYear()
  const M = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const h = String(date.getHours()).padStart(2, "0")
  const m = String(date.getMinutes()).padStart(2, "0")
  return `${y}-${M}-${d} ${h}:${m}`
}

// ─────────────────────────────────────────────
// File I/O Helpers (L2 Markdown)
// ─────────────────────────────────────────────

/** ----- L2 Markdown --（- META -） */
function parseL2File(filePath: string): L2Entry {
  const content = fs.readFileSync(filePath, "utf-8")
  const fileName = path.basename(filePath)

  const startIdx = content.indexOf(META_START)
  const endIdx = content.indexOf(META_END)

  const meta: L2Meta = { created: "", updated: "", summary: "", heat: 0 }
  let body = content

  if (startIdx !== -1 && endIdx !== -1) {
    const metaBlock = content.slice(startIdx + META_START.length, endIdx).trim()

    for (const line of metaBlock.split("\n")) {
      const colonIdx = line.indexOf(":")
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim()
        const val = line.slice(colonIdx + 1).trim()
        if (key === "heat") {
          meta.heat = parseInt(val, 10) || 0
        } else {
          ;(meta as Record<string, string | number>)[key] = val
        }
      }
    }

    body = content.slice(endIdx + META_END.length).trim()
  }

  return { fileName, meta, body }
}

function renderL0Table(records: Record<string, unknown>[]) {
  const headers = ["#", "timestamp", "role", "content"]
  const colWidths = [5, 18, 10, 50]

  const rows = records.map((r, i) => [
    String(i + 1),
    formatTime(r.timestamp),
    truncate(String(r.role ?? ""), 10),
    truncate(String(r.content ?? ""), 50),
  ])

  // --------（-- 30，-- 80）
  const maxContentWidth = Math.min(
    80,
    Math.max(30, ...rows.map((r) => displayWidth(r[3])))
  )
  colWidths[3] = maxContentWidth

  printTable(headers, rows, colWidths)
  console.log()
}

function renderL1Table(records: Record<string, unknown>[]) {
  const headers = ["#", "updatedAt", "type", "pri", "content"]
  const colWidths = [5, 18, 12, 4, 50]

  const rows = records.map((r, i) => [
    String(i + 1),
    formatTime(r.updatedAt),
    truncate(String(r.type ?? ""), 12),
    String(r.priority ?? ""),
    truncate(String(r.content ?? ""), 50),
  ])

  const maxContentWidth = Math.min(
    80,
    Math.max(30, ...rows.map((r) => displayWidth(r[4])))
  )
  colWidths[4] = maxContentWidth

  printTable(headers, rows, colWidths)
  console.log()
}

// ─────────────────────────────────────────────
// Query: L2 (Scene Blocks)
// ─────────────────────────────────────────────

function queryL2(opts: CliOptions) {
  const dirPath = path.join(opts.dataDir, LEVEL_DIRS.L2)

  if (!fs.existsSync(dirPath)) {
    // ------------（--------），-----
    if (opts.format === "json") {
      console.log(JSON.stringify({ level: "L2", total: 0, data: [] }))
      return
    }
    if (opts.format === "jsonl") {
      return
    }
    console.log()
    console.log(`📊  ----：L2 scene_blocks`)
    console.log(`   （--------）`)
    console.log()
    return
  }

  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".md")).sort()
  const entries: L2Entry[] = files.map((f) => parseL2File(path.join(dirPath, f)))

  // --file --：------------（- body）
  if (opts.file) {
    const target = entries.find((e) => e.fileName === opts.file)
    if (!target) {
      console.error(`❌  -----: ${opts.file}`)
      process.exit(1)
    }
    if (opts.format === "json") {
      console.log(JSON.stringify({
        level: "L2",
        fileName: target.fileName,
        ...target.meta,
        body: target.body,
      }))
      return
    }
    // table / jsonl ----------
    console.log(target.body)
    return
  }

  if (opts.format === "json") {
    // ------：------（-- body），---- TAT 24KB ----
    const result = {
      level: "L2",
      total: entries.length,
      data: entries.map(({ fileName, meta }) => ({
        fileName,
        ...meta,
      })),
    }
    console.log(JSON.stringify(result))
    return
  }

  if (opts.format === "jsonl") {
    for (const { fileName, meta, body } of entries) {
      console.log(JSON.stringify({ fileName, ...meta, body }))
    }
    return
  }

  // ── table -- ──
  console.log()
  console.log(`📊  ----：L2 scene_blocks`)
  console.log(`   ----: ${entries.length}`)
  console.log()

  if (entries.length === 0) {
    console.log("   （-------）")
    console.log()
    return
  }

  for (const { fileName, meta, body } of entries) {
    console.log(`${"─".repeat(60)}`)
    console.log(`📄  ${fileName}`)
    console.log(`   Summary : ${meta.summary}`)
    console.log(`   Heat    : ${meta.heat}`)
    console.log(`   Created : ${meta.created}`)
    console.log(`   Updated : ${meta.updated}`)
    console.log()

    // ----（--------）
    const lines = body.split("\n")
    const maxLines = 30
    if (lines.length > maxLines) {
      console.log(lines.slice(0, maxLines).join("\n"))
      console.log(`   ... (-- ${lines.length - maxLines} -，- ${lines.length} -)`)
    } else {
      console.log(body)
    }
    console.log()
  }
}

// ─────────────────────────────────────────────
// Query: L3 (Persona)
// ─────────────────────────────────────────────

function queryL3(opts: CliOptions) {
  const filePath = path.join(opts.dataDir, LEVEL_DIRS.L3)

  // ------------（------、------），-----
  if (!fs.existsSync(filePath)) {
    if (opts.format === "json") {
      console.log(JSON.stringify({ level: "L3", content: "" }))
      return
    }
    if (opts.format === "jsonl") {
      console.log(JSON.stringify({ level: "L3", content: "" }))
      return
    }
    console.log()
    console.log(`📊  ----：L3 persona`)
    console.log(`   （--------）`)
    console.log()
    return
  }

  const content = fs.readFileSync(filePath, "utf-8")

  if (opts.format === "json") {
    console.log(JSON.stringify({ level: "L3", content }))
    return
  }

  if (opts.format === "jsonl") {
    console.log(JSON.stringify({ level: "L3", content }))
    return
  }

  console.log()
  console.log(`📊  ----：L3 persona`)
  console.log(`${"─".repeat(60)}`)
  console.log(content)
  console.log()
}

// ─────────────────────────────────────────────
// Overview: -----
// ─────────────────────────────────────────────

function showOverview(db: DatabaseSync, opts: CliOptions) {
  console.log()
  console.log(`🗂️  Memory ----`)
  console.log(`   ----: ${opts.dataDir}`)
  console.log(`   ---: ${SQLITE_DB_NAME}`)
  console.log(`${"═".repeat(60)}`)

  // ── L0 ──
  try {
    const l0Count = (db.prepare("SELECT COUNT(*) AS cnt FROM l0_conversations").get() as { cnt: number }).cnt
    const l0Roles = db.prepare("SELECT role, COUNT(*) AS cnt FROM l0_conversations GROUP BY role").all() as Array<{ role: string; cnt: number }>
    const roleSummary = l0Roles.map((r) => `${r.role || "unknown"}: ${r.cnt}`).join(", ")

    console.log()
    console.log(`📂  L0 · conversations (l0_conversations)`)
    console.log(`   ---: ${l0Count}`)
    if (roleSummary) {
      console.log(`   ----: ${roleSummary}`)
    }
  } catch {
    console.log()
    console.log(`📂  L0 · conversations  （---------）`)
  }

  // ── L1 ──
  try {
    const l1Count = (db.prepare("SELECT COUNT(*) AS cnt FROM l1_records").get() as { cnt: number }).cnt
    const l1Types = db.prepare("SELECT type, COUNT(*) AS cnt FROM l1_records GROUP BY type").all() as Array<{ type: string; cnt: number }>
    const typeSummary = l1Types.map((t) => `${t.type || "unknown"}: ${t.cnt}`).join(", ")

    console.log()
    console.log(`📂  L1 · records (l1_records)`)
    console.log(`   ---: ${l1Count}`)
    if (typeSummary) {
      console.log(`   ----: ${typeSummary}`)
    }
  } catch {
    console.log()
    console.log(`📂  L1 · records  （---------）`)
  }

  // ── L2 ──
  const l2Dir = path.join(opts.dataDir, LEVEL_DIRS.L2)
  if (fs.existsSync(l2Dir)) {
    const files = fs.readdirSync(l2Dir).filter((f) => f.endsWith(".md"))
    const entries = files.map((f) => parseL2File(path.join(l2Dir, f)))
    const totalHeat = entries.reduce((sum, e) => sum + e.meta.heat, 0)

    console.log()
    console.log(`📂  L2 · scene_blocks`)
    console.log(`   ---: ${files.length}   ---: ${totalHeat}`)
    for (const entry of entries) {
      console.log(`   · ${entry.fileName}  (heat: ${entry.meta.heat})  ${truncate(entry.meta.summary, 40)}`)
    }
  } else {
    console.log()
    console.log(`📂  L2 · scene_blocks  （-----）`)
  }

  // ── L3 ──
  const l3Path = path.join(opts.dataDir, LEVEL_DIRS.L3)
  if (fs.existsSync(l3Path)) {
    const content = fs.readFileSync(l3Path, "utf-8")
    const lines = content.split("\n").length
    const bytes = Buffer.byteLength(content, "utf-8")

    console.log()
    console.log(`📂  L3 · persona`)
    console.log(`   --: ${formatBytes(bytes)}   --: ${lines}`)
  } else {
    console.log()
    console.log(`📂  L3 · persona  （-----）`)
  }

  console.log()
  console.log(`${"═".repeat(60)}`)
  console.log(`💡  -- -L <--> ------，-: -L L0 --since 7d`)
  console.log()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

/** ---- SQLite ---，------ null */
function tryOpenSqlite(dataDir: string): DatabaseSync | null {
  const dbPath = path.join(dataDir, SQLITE_DB_NAME)
  if (!fs.existsSync(dbPath)) {
    return null
  }
  return openSqliteReadonly(dbPath)
}

/** L0/L1 ------------（------：-----，------） */
function emptyL0L1Result(opts: CliOptions, level: "L0" | "L1") {
  if (opts.format === "json") {
    const result: QueryResult<Record<string, unknown>> = {
      level,
      total: 0,
      offset: opts.offset,
      limit: opts.limit,
      sort: opts.sort,
      filter: null,
      data: [],
    }
    console.log(JSON.stringify(result))
    return
  }
  if (opts.format === "jsonl") {
    return
  }
  const label = level === "L0" ? "conversations" : "records"
  console.log()
  console.log(`📊  ----：${level} ${label}（SQLite）`)
  console.log(`   （-------，----）`)
  console.log()
}

function main() {
  const opts = parseCli()

  // L2/L3 --- SQLite ---，----
  if (opts.level === "L2") {
    queryL2(opts)
    return
  }
  if (opts.level === "L3") {
    queryL3(opts)
    return
  }

  // L0/L1/------ SQLite
  const db = tryOpenSqlite(opts.dataDir)

  // ------：L0/L1 -----，------
  if (!db) {
    if (opts.level === "L0" || opts.level === "L1") {
      emptyL0L1Result(opts, opts.level)
      return
    }
    // ----：------，----
    console.error(`❌  SQLite ------: ${path.join(opts.dataDir, SQLITE_DB_NAME)}`)
    console.error(`   ---------- ${SQLITE_DB_NAME}`)
    process.exit(1)
  }

  try {
    if (!opts.level) {
      showOverview(db, opts)
      return
    }

    switch (opts.level) {
      case "L0":
        querySqliteLevel(db, opts, "L0")
        break
      case "L1":
        querySqliteLevel(db, opts, "L1")
        break
    }
  } finally {
    db.close()
  }
}

main()
