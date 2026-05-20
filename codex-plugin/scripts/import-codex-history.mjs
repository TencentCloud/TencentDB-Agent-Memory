#!/usr/bin/env node
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  ensureGateway,
  expandHome,
  httpPost,
  sanitizeMemoryText,
  sha1
} from "./lib.mjs";
import { normalizeL1Concurrency, positiveInteger } from "./seed-constants.mjs";

const DEFAULT_SESSIONS_DIR = "~/.codex/sessions";
const DEFAULT_ARCHIVED_DIR = "~/.codex/archived_sessions";
const DEFAULT_FULL_PIPELINE_TIMEOUT_MS = 900_000;
const DEFAULT_SEED_TIMEOUT_MS = 960_000;
const DEFAULT_MAX_JSONL_BYTES = 100 * 1024 * 1024;

export async function importCodexHistoryCli(args = process.argv.slice(2)) {
  const opts = parseArgs(args);
  if (opts.help) return usage(0);

  const roots = [opts.sessionsDir];
  if (opts.includeArchived) roots.push(opts.archivedDir);

  const files = [];
  for (const root of roots) {
    files.push(...await collectJsonlFiles(root, root === opts.archivedDir ? "archived" : "active"));
  }
  files.sort((a, b) => a.file.localeCompare(b.file));

  const selected = [];
  const skipped = {
    byDate: 0,
    byCwd: 0,
    empty: 0,
    parseError: 0,
    tooLarge: 0
  };

  for (const entry of files) {
    const parsed = await parseCodexRollout(entry, opts);
    if (!parsed.ok) {
      skipped[parsed.reason] = (skipped[parsed.reason] || 0) + 1;
      continue;
    }
    selected.push(parsed.session);
    if (opts.limit && selected.length >= opts.limit) break;
  }

  const seedData = { sessions: selected };
  const summary = summarize(files, selected, skipped, opts);

  if (opts.out) {
    await fs.mkdir(path.dirname(opts.out), { recursive: true });
    await fs.writeFile(opts.out, `${JSON.stringify(seedData, null, 2)}\n`, "utf-8");
    summary.output = opts.out;
  }

  if (opts.dryRun || !opts.yes) {
    summary.mode = "dry-run";
    summary.next = "Re-run with --yes to import these rounds through Gateway /seed.";
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (selected.length === 0) {
    summary.mode = "import";
    summary.imported = false;
    summary.reason = "no_sessions_with_user_assistant_rounds";
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const ready = await ensureGateway();
  if (!ready) {
    console.error("TDAI Gateway unavailable");
    process.exit(1);
  }

  const result = await httpPost("/seed", {
    data: seedData,
    strict_round_role: true,
    auto_fill_timestamps: false,
    wait_for_l1: opts.waitForL1,
    l1_concurrency: opts.l1Concurrency,
    l2_batch_size: opts.l2BatchSize,
    wait_for_full_pipeline: opts.fullPipeline,
    full_pipeline_timeout_ms: opts.fullPipelineTimeoutMs,
    import_into_current_store: opts.importIntoCurrentStore
  }, Number(process.env.TDAI_CODEX_SEED_TIMEOUT_MS || DEFAULT_SEED_TIMEOUT_MS));

  console.log(JSON.stringify({
    ...summary,
    mode: "import",
    imported: !!result,
    seedResult: result
  }, null, 2));
}

async function collectJsonlFiles(root, kind) {
  const dir = path.resolve(expandHome(root));
  if (!fsSync.existsSync(dir)) return [];
  const found = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.push({ file: full, kind });
      }
    }
  }
  await walk(dir);
  return found;
}

async function parseCodexRollout(entry, opts) {
  try {
    const stat = await fs.stat(entry.file);
    const configuredMaxBytes = Number(process.env.TDAI_CODEX_IMPORT_MAX_JSONL_BYTES || DEFAULT_MAX_JSONL_BYTES);
    const maxBytes = Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0
      ? configuredMaxBytes
      : DEFAULT_MAX_JSONL_BYTES;
    if (stat.size > maxBytes) return { ok: false, reason: "tooLarge" };
  } catch {
    return { ok: false, reason: "parseError" };
  }

  let sessionId = path.basename(entry.file, ".jsonl");
  let sessionCwd = "";
  let sessionTimestamp = 0;
  let source = "";
  const messages = [];
  let messageIndex = 0;

  try {
    const lines = createInterface({
      input: fsSync.createReadStream(entry.file, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }

      const payload = row.payload || {};
      if (row.type === "session_meta") {
        sessionId = payload.id || sessionId;
        sessionCwd = payload.cwd || sessionCwd;
        sessionTimestamp = timestampMs(payload.timestamp || row.timestamp) || sessionTimestamp;
        source = sourceLabel(payload.source);
        continue;
      }

      if (row.type !== "response_item" || payload.type !== "message") continue;
      if (payload.role !== "user" && payload.role !== "assistant") continue;

      const content = sanitizeMemoryText(contentToText(payload.content));
      if (shouldSkipMessage(payload.role, content)) continue;

      const timestamp = timestampMs(row.timestamp) || sessionTimestamp || Date.now();
      messages.push({
        id: stableMessageId(entry.file, sessionId, messageIndex, payload.role, timestamp, content),
        role: payload.role,
        content,
        timestamp
      });
      messageIndex++;
    }
  } catch {
    return { ok: false, reason: "parseError" };
  }

  if (opts.since && sessionTimestamp && sessionTimestamp < opts.since) {
    return { ok: false, reason: "byDate" };
  }

  if (opts.cwd) {
    const wanted = path.resolve(expandHome(opts.cwd));
    const actual = sessionCwd ? path.resolve(expandHome(sessionCwd)) : "";
    if (actual !== wanted) return { ok: false, reason: "byCwd" };
  }

  const conversations = pairMessages(messages);
  if (conversations.length === 0) return { ok: false, reason: "empty" };

  const cwdLabel = sessionCwd || "unknown-cwd";
  return {
    ok: true,
    session: {
      sessionKey: `codex-import:${sha1(cwdLabel).slice(0, 10)}:${safeKey(sessionId)}`,
      sessionId,
      conversations,
      metadata: {
        source: "codex-jsonl",
        codexSource: source || undefined,
        codexCwd: sessionCwd || undefined,
        codexArchiveKind: entry.kind,
        codexPath: entry.file
      }
    }
  };
}

function pairMessages(messages) {
  const rounds = [];
  let pendingUser = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      if (pendingUser) {
        pendingUser.content = `${pendingUser.content}\n\n${msg.content}`;
        pendingUser.timestamp = Math.min(pendingUser.timestamp, msg.timestamp);
      } else {
        pendingUser = { ...msg };
      }
      continue;
    }

    if (msg.role === "assistant" && pendingUser) {
      rounds.push([
        pendingUser,
        msg
      ]);
      pendingUser = null;
    }
  }

  return rounds;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
    return "";
  }).filter(Boolean).join("\n");
}

function shouldSkipMessage(role, text) {
  const value = String(text || "").trim();
  if (!value) return true;
  if (value.includes("<tdai-codex-memory-context>")) return true;
  if (value.includes("<tdai-codex-context-offload>")) return true;
  if (value.includes("<tdai-codex-tool-memory-hint>")) return true;
  if (value.includes("<tdai-codex-tool-output-offload>")) return true;
  if (role === "user" && value.startsWith("# AGENTS.md instructions")) return true;
  if (role === "user" && value.startsWith("<environment_context>")) return true;
  if (role === "user" && value.startsWith("<INSTRUCTIONS>")) return true;
  return false;
}

function summarize(files, sessions, skipped, opts) {
  const rounds = sessions.reduce((sum, session) => sum + session.conversations.length, 0);
  const messages = sessions.reduce((sum, session) => (
    sum + session.conversations.reduce((inner, round) => inner + round.length, 0)
  ), 0);
  const byKind = sessions.reduce((acc, session) => {
    const kind = session.metadata?.codexArchiveKind || "unknown";
    acc[kind] = (acc[kind] || 0) + 1;
    return acc;
  }, {});
  return {
    source: "codex-jsonl",
    sessionsDir: opts.sessionsDir,
    archivedDir: opts.includeArchived ? opts.archivedDir : null,
    includeArchived: opts.includeArchived,
    waitForFullPipeline: opts.fullPipeline,
    waitForL1: opts.waitForL1,
    l1Concurrency: opts.l1Concurrency,
    l2BatchSize: opts.l2BatchSize,
    importIntoCurrentStore: opts.importIntoCurrentStore,
    fullPipelineTimeoutMs: opts.fullPipelineTimeoutMs,
    cwd: opts.cwd || null,
    since: opts.since ? new Date(opts.since).toISOString() : null,
    filesScanned: files.length,
    sessionsPrepared: sessions.length,
    roundsPrepared: rounds,
    messagesPrepared: messages,
    sessionsByKind: byKind,
    skipped
  };
}

function parseArgs(args) {
  const opts = {
    sessionsDir: path.resolve(expandHome(process.env.CODEX_SESSIONS_DIR || DEFAULT_SESSIONS_DIR)),
    archivedDir: path.resolve(expandHome(process.env.CODEX_ARCHIVED_SESSIONS_DIR || DEFAULT_ARCHIVED_DIR)),
    includeArchived: true,
    fullPipeline: true,
    importIntoCurrentStore: true,
    waitForL1: true,
    l1Concurrency: normalizeL1Concurrency(process.env.TDAI_CODEX_IMPORT_L1_CONCURRENCY, 8),
    l2BatchSize: positiveInteger(process.env.TDAI_CODEX_IMPORT_L2_BATCH_SIZE, 32, 128),
    fullPipelineTimeoutMs: positiveNumber(process.env.TDAI_CODEX_FULL_PIPELINE_TIMEOUT_MS, DEFAULT_FULL_PIPELINE_TIMEOUT_MS),
    dryRun: false,
    yes: false,
    cwd: "",
    since: 0,
    limit: 0,
    out: ""
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--no-archived") opts.includeArchived = false;
    else if (arg === "--no-full-pipeline") {
      opts.fullPipeline = false;
      opts.waitForL1 = false;
    }
    else if (arg === "--no-wait-for-l1") opts.waitForL1 = false;
    else if (arg === "--snapshot-seed") opts.importIntoCurrentStore = false;
    else if (arg === "--full-pipeline-timeout-ms") opts.fullPipelineTimeoutMs = positiveNumber(next(args, ++i, arg), 0);
    else if (arg === "--l1-concurrency") opts.l1Concurrency = normalizeL1Concurrency(next(args, ++i, arg), 1);
    else if (arg === "--l2-batch-size") opts.l2BatchSize = positiveInteger(next(args, ++i, arg), 1, 128);
    else if (arg === "--sessions-dir") opts.sessionsDir = path.resolve(expandHome(next(args, ++i, arg)));
    else if (arg === "--archived-dir") opts.archivedDir = path.resolve(expandHome(next(args, ++i, arg)));
    else if (arg === "--cwd") opts.cwd = next(args, ++i, arg);
    else if (arg === "--since") opts.since = parseSince(next(args, ++i, arg));
    else if (arg === "--limit") opts.limit = Math.max(0, Number(next(args, ++i, arg)) || 0);
    else if (arg === "--out") opts.out = path.resolve(expandHome(next(args, ++i, arg)));
    else throw new Error(`Unknown option: ${arg}`);
  }

  return opts;
}

function next(args, index, flag) {
  if (index >= args.length) throw new Error(`${flag} requires a value`);
  return args[index];
}

function parseSince(value) {
  const raw = String(value || "").trim();
  const days = raw.match(/^(\d+)d$/i);
  if (days) return Date.now() - Number(days[1]) * 24 * 60 * 60 * 1000;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --since value: ${value}`);
  return parsed;
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function timestampMs(value) {
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function sourceLabel(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.subagent) return "subagent";
  return "object";
}

function safeKey(value) {
  return String(value).replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120);
}

function stableMessageId(file, sessionId, index, role, timestamp, content) {
  const digest = sha1([
    "codex-import-message",
    path.resolve(file),
    sessionId,
    index,
    role,
    timestamp,
    content
  ].join("\0")).slice(0, 20);
  return `codex_import_${digest}`;
}

function usage(code = 0) {
  const message = `Usage: node scripts/import-codex-history.mjs [options]

Import local Codex JSONL history into TencentDB Agent Memory through Gateway /seed.
By default this is a dry run unless --yes is provided.

Options:
  --dry-run                Show the import plan without writing to the Gateway.
  --yes, -y                Actually import prepared rounds through /seed.
  --sessions-dir <path>    Active Codex sessions directory. Default: ${DEFAULT_SESSIONS_DIR}
  --archived-dir <path>    Archived Codex sessions directory. Default: ${DEFAULT_ARCHIVED_DIR}
  --no-archived            Do not include archived Codex JSONL files.
  --no-full-pipeline       Only write L0 records; skip the final L1/L2/L3 flush.
  --no-wait-for-l1         Do not wait for per-session L1 batches; intended for L0-only imports.
  --l1-concurrency <n>     Concurrent L1 extraction tasks for this import. Default: 8.
  --l2-batch-size <n>      L1 records per bulk L2 scene batch. Default: 32.
  --snapshot-seed          Write to an isolated seed-* directory instead of the current memory store.
  --full-pipeline-timeout-ms <n>
                           Max wait for the final L1/L2/L3 flush. Default: ${DEFAULT_FULL_PIPELINE_TIMEOUT_MS}
  --cwd <path>             Import only sessions whose session_meta.cwd matches this path.
  --since <date|Nd>        Import only sessions newer than an ISO date or relative day window.
  --limit <n>              Import at most n prepared sessions.
  --out <file>             Write the generated Gateway /seed JSON to a file.
`;
  (code === 0 ? console.log : console.error)(message);
  process.exit(code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  importCodexHistoryCli().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
