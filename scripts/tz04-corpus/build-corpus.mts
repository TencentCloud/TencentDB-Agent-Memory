/**
 * tz-04 C1 — build the stratified probe corpus out of a COPY of a real store.
 *
 * Six cells: {instruction, persona, episodic} × {own, foreign}. "own" asks the
 * query from the project the answer lives in; "foreign" asks the SAME answer
 * from another project, which is the only way a cross-project multiplier shows
 * up in a metric instead of in a belief.
 *
 * Two origins, because a corpus written from the store's own wording measures
 * how well recall reproduces itself (R3):
 *   - `store-derived` — the query is built from the record's content;
 *   - `owner-task`    — the query IS a real user message from `l0_conversations`
 *                       of the same session that produced the record. That is
 *                       the owner's own phrasing, not a paraphrase of output.
 *
 * Deterministic: everything is sorted by record_id, nothing is random, so two
 * runs over the same store give the same corpus.
 *
 * Read-only: the database is opened readonly and never written. Point it at a
 * COPY — the live store is not a scratch pad.
 *
 * Usage:
 *   npx tsx scripts/tz04-corpus/build-corpus.mts --db /tmp/copy/vectors.db \
 *     --out ~/.pi/agent-memory/tdai/probe-corpus.json [--per-cell 20]
 */
import fs from "node:fs";
import { openReadonlySqlite } from "../../src/gateway/http-utils.js";
import type { ProbeQuery } from "../../src/gateway/probe.js";

/** tz-04 C1: 20 pairs per cell is the target, 10 the indicative minimum. */
const DEFAULT_PER_CELL = 20;
/** Shortest usable query — below this a "query" is a word, not a question. */
const MIN_QUERY_CHARS = 12;
/** Longest query kept; owner messages can be pages long. */
const MAX_QUERY_CHARS = 200;

interface Args {
  db: string;
  out: string;
  perCell: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { db: "", out: "", perCell: DEFAULT_PER_CELL };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--db") args.db = argv[++i] ?? "";
    else if (arg === "--out") args.out = argv[++i] ?? "";
    else if (arg === "--per-cell") args.perCell = Number(argv[++i]);
    else throw new Error(`неизвестный аргумент "${arg}"`);
  }
  if (!args.db || !args.out) {
    throw new Error(
      "usage: build-corpus.mts --db <копия vectors.db> --out <corpus.json> [--per-cell N]",
    );
  }
  if (!Number.isInteger(args.perCell) || args.perCell <= 0) {
    throw new Error(
      `--per-cell ждёт положительное целое, а получил "${args.perCell}"`,
    );
  }
  return args;
}

type L1Type = NonNullable<ProbeQuery["expectedType"]>;
const TYPES: L1Type[] = ["instruction", "persona", "episodic"];

interface Row {
  record_id: string;
  content: string;
  type: string;
  project_id: string;
  session_id: string;
}

/** One line of natural language out of a stored record. */
function storeDerivedQuery(content: string): string {
  const flat = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`>|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
  const query = (sentence.length >= MIN_QUERY_CHARS ? sentence : flat).slice(
    0,
    MAX_QUERY_CHARS,
  );
  return query.trim();
}

/** Trim an owner's message to a query-sized piece without inventing words. */
function ownerQuery(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}

const args = parseArgs(process.argv.slice(2));
const db = openReadonlySqlite(args.db);

// L1 only (C1b): L0 conversations, L2 scenes and L3 persona files are other
// layers and must not be mixed into a recall corpus.
const rows = db
  .prepare(
    `SELECT record_id, content, type, project_id, session_id
       FROM l1_records
      WHERE project_id != '' AND content != ''
      ORDER BY record_id`,
  )
  .all() as Row[];

/** The owner's own message for a record's session, if there is a usable one. */
const ownerMessage = db.prepare(
  `SELECT message_text
     FROM l0_conversations
    WHERE session_id = ? AND role = 'user' AND length(message_text) >= ?
    ORDER BY record_id
    LIMIT 1`,
);

const projects = [...new Set(rows.map((r) => r.project_id))].sort();
if (projects.length < 2) {
  throw new Error(
    `в сторе только ${projects.length} проект(ов) — страта "foreign" непостроима`,
  );
}

/** A stable other project for a given one: the next in sorted order. */
function foreignProject(own: string): string {
  const index = projects.indexOf(own);
  return projects[(index + 1) % projects.length]!;
}

const queries: ProbeQuery[] = [];
const counts = new Map<string, number>();
const originCounts = new Map<string, number>();

for (const type of TYPES) {
  const ofType = rows.filter((r) => r.type === type);
  for (const relation of ["own", "foreign"] as const) {
    const cell = `${type}/${relation}`;
    for (const row of ofType) {
      if ((counts.get(cell) ?? 0) >= args.perCell) break;
      const owner = ownerMessage.get(row.session_id, MIN_QUERY_CHARS) as
        { message_text?: string } | undefined;
      // Every second pair in a cell prefers the owner's phrasing, so the third
      // asked for by C1 is reached without cherry-picking which records get it.
      const preferOwner = (counts.get(cell) ?? 0) % 2 === 1;
      const query =
        preferOwner && owner?.message_text
          ? ownerQuery(owner.message_text)
          : storeDerivedQuery(row.content);
      if (query.length < MIN_QUERY_CHARS) continue;
      const origin: ProbeQuery["origin"] =
        preferOwner && owner?.message_text ? "owner-task" : "store-derived";
      queries.push({
        id: `${cell}/${row.record_id}`,
        query,
        // "own" asks from the record's project; "foreign" asks the same answer
        // from a neighbouring project — that is what makes the answer foreign.
        projectId:
          relation === "own" ? row.project_id : foreignProject(row.project_id),
        expected: [row.content.slice(0, 60).trim()],
        expectedRecordIds: [row.record_id],
        expectedType: type,
        scopeRelation: relation,
        origin,
      });
      counts.set(cell, (counts.get(cell) ?? 0) + 1);
      originCounts.set(origin, (originCounts.get(origin) ?? 0) + 1);
    }
  }
}

db.close();

fs.writeFileSync(
  args.out,
  `${JSON.stringify({ queries }, null, 2)}\n`,
  "utf-8",
);

console.log(
  `записей L1 с проектом: ${rows.length}, проектов: ${projects.length}`,
);
console.log(
  `корпус: ${args.out} (пар: ${queries.length}, цель на ячейку: ${args.perCell})`,
);
for (const type of TYPES) {
  for (const relation of ["own", "foreign"] as const) {
    const cell = `${type}/${relation}`;
    const n = counts.get(cell) ?? 0;
    console.log(
      `  ${cell.padEnd(22)} пар=${String(n).padStart(3)}${n < 10 ? " ⚠ ниже минимума C1" : ""}`,
    );
  }
}
const ownerPairs = originCounts.get("owner-task") ?? 0;
const share = queries.length > 0 ? (ownerPairs / queries.length) * 100 : 0;
console.log(
  `origin: owner-task=${ownerPairs} store-derived=${originCounts.get("store-derived") ?? 0} ` +
    `(доля формулировок владельца: ${share.toFixed(1)}%${share < 33.3 ? " ⚠ ниже трети (C1)" : ""})`,
);
