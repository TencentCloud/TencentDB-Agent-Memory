import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TOOL_OFFLOAD_MIN_CHARS = 20_000;
const DEFAULT_TOOL_OFFLOAD_AGGRESSIVE_MIN_CHARS = 80_000;
const DEFAULT_TOOL_OFFLOAD_EMERGENCY_MIN_CHARS = 250_000;
const DEFAULT_TOOL_OFFLOAD_PREVIEW_CHARS = 2_000;
const DEFAULT_TOOL_OFFLOAD_AGGRESSIVE_PREVIEW_CHARS = 800;
const DEFAULT_TOOL_OFFLOAD_EMERGENCY_PREVIEW_CHARS = 240;
const DEFAULT_TOOL_OFFLOAD_MAX_STORE_CHARS = 2_000_000;
const DEFAULT_TOOL_OFFLOAD_L2_NULL_THRESHOLD = 1;
const DEFAULT_TOOL_OFFLOAD_CONTEXT_CHARS = 6_000;
const DEFAULT_TOOL_OFFLOAD_LOOKUP_CONTENT_CHARS = 20_000;
const CANVAS_FILE = "001-codex-tool-offload.mmd";
const NODE_INDEX_FILE = "node-index.json";
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function selectToolOffloadPolicy(charCount) {
  const mildMin = numericEnv(
    "TDAI_CODEX_TOOL_OFFLOAD_MILD_MIN_CHARS",
    numericEnv("TDAI_CODEX_TOOL_OFFLOAD_MIN_CHARS", DEFAULT_TOOL_OFFLOAD_MIN_CHARS),
  );
  const aggressiveMin = numericEnv(
    "TDAI_CODEX_TOOL_OFFLOAD_AGGRESSIVE_MIN_CHARS",
    Math.max(DEFAULT_TOOL_OFFLOAD_AGGRESSIVE_MIN_CHARS, mildMin * 4),
  );
  const emergencyMin = numericEnv(
    "TDAI_CODEX_TOOL_OFFLOAD_EMERGENCY_MIN_CHARS",
    Math.max(DEFAULT_TOOL_OFFLOAD_EMERGENCY_MIN_CHARS, aggressiveMin * 3),
  );

  if (charCount >= emergencyMin) {
    return {
      name: "emergency",
      minChars: emergencyMin,
      previewChars: numericEnv("TDAI_CODEX_TOOL_OFFLOAD_EMERGENCY_PREVIEW_CHARS", DEFAULT_TOOL_OFFLOAD_EMERGENCY_PREVIEW_CHARS),
      score: 10,
    };
  }
  if (charCount >= aggressiveMin) {
    return {
      name: "aggressive",
      minChars: aggressiveMin,
      previewChars: numericEnv("TDAI_CODEX_TOOL_OFFLOAD_AGGRESSIVE_PREVIEW_CHARS", DEFAULT_TOOL_OFFLOAD_AGGRESSIVE_PREVIEW_CHARS),
      score: 9,
    };
  }
  if (charCount >= mildMin) {
    return {
      name: "mild",
      minChars: mildMin,
      previewChars: numericEnv("TDAI_CODEX_TOOL_OFFLOAD_PREVIEW_CHARS", DEFAULT_TOOL_OFFLOAD_PREVIEW_CHARS),
      score: 8,
    };
  }
  return null;
}

export function maxStoreChars() {
  return numericEnv("TDAI_CODEX_TOOL_OFFLOAD_MAX_STORE_CHARS", DEFAULT_TOOL_OFFLOAD_MAX_STORE_CHARS);
}

export async function recordCodexToolOffload(params) {
  const {
    sessionKey,
    sessionId,
    cwd,
    toolName,
    toolUseId,
    inputSummary,
    redactedOutput,
    storedText,
    policy,
  } = params;
  const paths = pathsForSession(sessionKey, sessionId);
  await ensureOffloadDirs(paths);

  const entries = await readEntries(paths.offloadJsonl);
  const existing = entries.find((entry) => entry.tool_call_id === toolUseId);
  if (existing) {
    const canvas = await maybeRebuildCanvas(paths, entries, { force: false });
    return {
      entry: existing,
      paths,
      canvas,
      duplicated: true,
    };
  }

  const now = new Date();
  const fileStem = `${safeKey(toolName)}-${safeKey(toolUseId)}-${now.getTime()}`;
  const resultRef = `refs/${fileStem}.md`;
  const refPath = path.join(paths.root, resultRef);
  const summary = summarizeToolResult(toolName, inputSummary, redactedOutput.length, policy);
  const entry = {
    timestamp: now.toISOString(),
    node_id: null,
    tool_call: `${toolName}: ${singleLine(inputSummary, 220) || "(no input captured)"}`,
    summary,
    result_ref: resultRef,
    tool_call_id: toolUseId,
    session_key: sessionKey,
    score: policy.score,
    codex: {
      session_id: sessionId,
      cwd,
      tool_name: toolName,
      policy: policy.name,
      original_chars_redacted: redactedOutput.length,
      stored_chars: storedText.length,
    },
  };

  await writePrivateFile(refPath, buildRefMarkdown({
    entry,
    cwd,
    inputSummary,
    redactedOutput,
    storedText,
    policy,
  }));

  entries.push(entry);
  await writeEntries(paths.offloadJsonl, entries);
  const canvas = await maybeRebuildCanvas(paths, entries, { force: false });
  const refreshed = await readEntries(paths.offloadJsonl);
  const updatedEntry = refreshed.find((candidate) => candidate.tool_call_id === toolUseId) || entry;
  if (updatedEntry.node_id !== entry.node_id) {
    await writePrivateFile(refPath, buildRefMarkdown({
      entry: updatedEntry,
      cwd,
      inputSummary,
      redactedOutput,
      storedText,
      policy,
    }));
  }

  return {
    entry: updatedEntry,
    paths,
    canvas,
    duplicated: false,
  };
}

export async function buildCodexOffloadContext(params) {
  const { sessionKey, sessionId } = params;
  const maxChars = params.maxChars ?? numericEnv("TDAI_CODEX_TOOL_OFFLOAD_CONTEXT_CHARS", DEFAULT_TOOL_OFFLOAD_CONTEXT_CHARS);
  const paths = pathsForSession(sessionKey, sessionId);
  const entries = await readEntries(paths.offloadJsonl);
  if (entries.length === 0) return "";

  let canvas = "";
  try {
    canvas = await fs.readFile(paths.canvasPath, "utf-8");
  } catch {
    const rebuilt = await maybeRebuildCanvas(paths, entries, { force: true });
    canvas = rebuilt?.content || "";
  }

  const recentLimit = numericEnv("TDAI_CODEX_TOOL_OFFLOAD_CONTEXT_RECENT", 8);
  const recent = entries.slice(-recentLimit).map((entry) => {
    return [
      `- node_id=${entry.node_id || "pending"}`,
      `tool_call_id=${entry.tool_call_id}`,
      `tool=${entry.codex?.tool_name || toolNameFromCall(entry.tool_call)}`,
      `policy=${entry.codex?.policy || "unknown"}`,
      `ref=${path.join(paths.root, entry.result_ref)}`,
      `summary=${singleLine(entry.summary, 220)}`,
    ].join(" ");
  }).join("\n");

  const block = `<tdai-codex-context-offload>
<policy>
Large Codex tool results are stored outside the prompt and represented by node ids.
Use tdai_offload_lookup with a node_id or tool_call_id when exact stored output is needed.
</policy>
<canvas path="${escapeAttr(paths.canvasPath)}">
\`\`\`mermaid
${stripMermaidFence(canvas).trim()}
\`\`\`
</canvas>
<recent-offloaded-results>
${escapeText(recent)}
</recent-offloaded-results>
</tdai-codex-context-offload>`;

  return truncate(block, maxChars);
}

export async function lookupCodexOffload(params = {}) {
  const roots = await listSessionRoots(params.sessionKey ? sessionRootFromKey(params.sessionKey) : null);
  const nodeId = optionalLower(params.nodeId);
  const toolCallId = optionalLower(params.toolCallId);
  const query = optionalLower(params.query);
  const cwd = normalizePath(params.cwd);
  const includeContent = params.includeContent === true;
  const contentMaxChars = params.contentMaxChars ?? DEFAULT_TOOL_OFFLOAD_LOOKUP_CONTENT_CHARS;
  const limit = clampLimit(params.limit, 10, 50);
  const matches = [];

  for (const root of roots) {
    let realRoot;
    try {
      realRoot = fsSync.realpathSync(root);
    } catch {
      continue;
    }
    const files = await listOffloadJsonlFiles(root);
    for (const file of files) {
      const entries = await readEntries(file);
      for (const entry of entries) {
        if (nodeId && optionalLower(entry.node_id) !== nodeId) continue;
        if (toolCallId && optionalLower(entry.tool_call_id) !== toolCallId) continue;
        if (query && !entryMatchesQuery(entry, query)) continue;
        if (cwd && normalizePath(entry.codex?.cwd) !== cwd) continue;

        const resultPath = entry.result_ref ? safeResolveUnderRoot(root, realRoot, entry.result_ref) : "";
        const item = {
          node_id: entry.node_id,
          tool_call_id: entry.tool_call_id,
          tool_call: entry.tool_call,
          summary: entry.summary,
          score: entry.score,
          policy: entry.codex?.policy,
          timestamp: entry.timestamp,
          session_key: entry.session_key,
          result_ref: entry.result_ref,
          result_path: resultPath,
          offload_jsonl: file,
          canvas_path: path.join(root, "mmds", CANVAS_FILE),
        };
        if (includeContent && resultPath) {
          item.content = await readFileIfExists(resultPath, contentMaxChars);
        }
        matches.push(item);
        if (matches.length >= limit) {
          return { matches, total: matches.length, truncated: true };
        }
      }
    }
  }

  return { matches, total: matches.length, truncated: false };
}

function safeResolveUnderRoot(root, resolvedRoot, relativePath) {
  const resolved = path.resolve(root, relativePath);
  const parent = path.dirname(resolved);
  let realParent;
  try {
    realParent = fsSync.realpathSync(parent);
  } catch {
    return "";
  }
  if (realParent !== resolvedRoot && !realParent.startsWith(`${resolvedRoot}${path.sep}`)) {
    return "";
  }
  return path.join(realParent, path.basename(resolved));
}

export async function offloadCli(args, context = {}) {
  const command = args[0] || "list";
  if (command === "help" || command === "--help" || command === "-h") return offloadUsage(0);

  if (command === "list") {
    const opts = parseLookupArgs(args.slice(1));
    const result = await lookupCodexOffload({
      sessionKey: opts.all ? "" : context.sessionKey,
      query: opts.query,
      includeContent: false,
      limit: opts.limit,
    });
    console.log(formatLookupText(result));
    return;
  }

  if (command === "node") {
    const id = args[1];
    if (!id) return offloadUsage(2);
    const opts = parseLookupArgs(args.slice(2));
    let result = await lookupCodexOffload({
      nodeId: id,
      query: opts.query,
      includeContent: opts.content,
      limit: opts.limit || 5,
    });
    if (result.matches.length === 0) {
      result = await lookupCodexOffload({
        toolCallId: id,
        query: opts.query,
        includeContent: opts.content,
        limit: opts.limit || 5,
      });
    }
    console.log(opts.json ? JSON.stringify(result, null, 2) : formatLookupText(result));
    return;
  }

  if (command === "canvas") {
    const paths = pathsForSession(context.sessionKey, context.sessionId);
    const content = await readFileIfExists(paths.canvasPath, 200_000);
    if (!content) {
      console.error(`No Codex offload canvas found for session: ${context.sessionKey}`);
      process.exit(1);
    }
    console.log(content);
    return;
  }

  return offloadUsage(2);
}

export function formatLookupText(result) {
  if (!result.matches.length) return "No matching Codex offload entries found.";
  return result.matches.map((entry) => {
    const parts = [
      `node_id: ${entry.node_id || "pending"}`,
      `tool_call_id: ${entry.tool_call_id}`,
      `tool_call: ${entry.tool_call}`,
      `policy: ${entry.policy || "unknown"}`,
      `score: ${entry.score ?? ""}`,
      `timestamp: ${entry.timestamp}`,
      `result_path: ${entry.result_path}`,
      `canvas_path: ${entry.canvas_path}`,
      "",
      entry.summary,
    ];
    if (entry.content) {
      parts.push("", "content:", entry.content);
    }
    return parts.join("\n");
  }).join("\n\n---\n\n");
}

function pathsForSession(sessionKey, sessionId) {
  const root = sessionRootFromKey(sessionKey);
  return {
    root,
    refsDir: path.join(root, "refs"),
    mmdsDir: path.join(root, "mmds"),
    offloadJsonl: path.join(root, `offload-${safeKey(sessionId || "unknown-session")}.jsonl`),
    canvasPath: path.join(root, "mmds", CANVAS_FILE),
    nodeIndexPath: path.join(root, NODE_INDEX_FILE),
  };
}

function sessionRootFromKey(sessionKey) {
  return path.join(tdaiDataDir(), "codex-adapter", "context-offload", sha1(sessionKey || "all").slice(0, 16));
}

async function ensureOffloadDirs(paths) {
  await ensurePrivateDir(paths.root);
  await ensurePrivateDir(paths.refsDir);
  await ensurePrivateDir(paths.mmdsDir);
}

async function maybeRebuildCanvas(paths, entries, options = {}) {
  if (process.env.TDAI_CODEX_TOOL_OFFLOAD_L2_CANVAS === "false") return null;
  const nullCount = entries.filter((entry) => !entry.node_id || entry.node_id === "wait").length;
  const threshold = numericEnv("TDAI_CODEX_TOOL_OFFLOAD_L2_NULL_THRESHOLD", DEFAULT_TOOL_OFFLOAD_L2_NULL_THRESHOLD);
  if (!options.force && nullCount < threshold && fsSync.existsSync(paths.canvasPath)) {
    return {
      path: paths.canvasPath,
      content: await readFileIfExists(paths.canvasPath, 200_000),
      rebuilt: false,
    };
  }

  const updated = assignNodeIds(entries, paths.root);
  const content = buildMermaidCanvas(updated, paths);
  await ensurePrivateDir(paths.mmdsDir);
  await writePrivateFile(paths.canvasPath, `${content}\n`);
  await writePrivateFile(paths.nodeIndexPath, `${JSON.stringify({
    version: 1,
    generated_at: new Date().toISOString(),
    offload_jsonl: paths.offloadJsonl,
    canvas_path: paths.canvasPath,
    nodes: updated.map((entry) => ({
      node_id: entry.node_id,
      tool_call_id: entry.tool_call_id,
      result_ref: entry.result_ref,
      result_path: path.join(paths.root, entry.result_ref),
      summary: entry.summary,
    })),
  }, null, 2)}\n`);
  await writeEntries(paths.offloadJsonl, updated);
  return { path: paths.canvasPath, content, rebuilt: true };
}

function assignNodeIds(entries, root) {
  const prefix = `C${sha1(root).slice(0, 6)}`;
  const used = new Set(entries.map((entry) => entry.node_id).filter(Boolean));
  let next = 1;
  return entries.map((entry) => {
    if (entry.node_id && entry.node_id !== "wait") return entry;
    let nodeId;
    do {
      nodeId = `${prefix}_N${String(next).padStart(3, "0")}`;
      next += 1;
    } while (used.has(nodeId));
    used.add(nodeId);
    return { ...entry, node_id: nodeId };
  });
}

function buildMermaidCanvas(entries, paths) {
  const lines = [
    "%% TencentDB Agent Memory Codex context offload canvas",
    `%% generated_at: ${new Date().toISOString()}`,
    `%% offload_jsonl: ${paths.offloadJsonl}`,
    "flowchart TD",
  ];

  if (entries.length === 0) {
    lines.push("  EMPTY[\"No offloaded tool results yet\"]");
    return lines.join("\n");
  }

  for (const entry of entries) {
    const label = [
      toolNameFromCall(entry.tool_call),
      `status: done`,
      `policy: ${entry.codex?.policy || "unknown"}`,
      `summary: ${singleLine(entry.summary, 130)}`,
      `ref: ${path.basename(entry.result_ref || "")}`,
    ].map(escapeMermaidLabel).join("<br/>");
    lines.push(`  ${entry.node_id}["${label}"]`);
  }

  for (let i = 1; i < entries.length; i++) {
    lines.push(`  ${entries[i - 1].node_id} --> ${entries[i].node_id}`);
  }

  lines.push("  classDef offloaded fill:#eef6ff,stroke:#3b82f6,color:#0f172a;");
  lines.push(`  class ${entries.map((entry) => entry.node_id).join(",")} offloaded;`);
  return lines.join("\n");
}

async function readEntries(filePath) {
  if (!filePath || !fsSync.existsSync(filePath)) return [];
  const content = await fs.readFile(filePath, "utf-8");
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && parsed.tool_call_id) entries.push(parsed);
    } catch {
      // Ignore corrupt lines rather than breaking hook execution.
    }
  }
  return entries;
}

async function writeEntries(filePath, entries) {
  await ensurePrivateDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writePrivateFile(tmp, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await fs.rename(tmp, filePath);
  await chmodPrivateFile(filePath);
}

async function listSessionRoots(singleRoot) {
  if (singleRoot) return fsSync.existsSync(singleRoot) ? [singleRoot] : [];
  const base = path.join(tdaiDataDir(), "codex-adapter", "context-offload");
  if (!fsSync.existsSync(base)) return [];
  const entries = await fs.readdir(base, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(base, entry.name)).sort();
}

async function listOffloadJsonlFiles(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.startsWith("offload-") && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(root, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function buildRefMarkdown(params) {
  const { entry, cwd, inputSummary, storedText, redactedOutput, policy } = params;
  return [
    "# Codex Tool Result Offload",
    "",
    `- node_id: ${entry.node_id || "pending_until_l2_canvas"}`,
    `- tool_call_id: ${entry.tool_call_id}`,
    `- tool_name: ${entry.codex.tool_name}`,
    `- session_key: ${entry.session_key}`,
    `- cwd: ${cwd}`,
    `- captured_at: ${entry.timestamp}`,
    `- policy: ${policy.name}`,
    `- original_chars_redacted: ${redactedOutput.length}`,
    `- stored_chars: ${storedText.length}`,
    "",
    "## Summary",
    "",
    entry.summary,
    "",
    "## Tool Input",
    "",
    "```text",
    inputSummary || "(no input captured)",
    "```",
    "",
    "## Tool Output",
    "",
    "```text",
    storedText,
    "```",
  ].join("\n");
}

function summarizeToolResult(toolName, inputSummary, charCount, policy) {
  const input = singleLine(inputSummary, 120);
  return [
    `${toolName} produced a ${policy.name} offloaded result (${charCount} redacted characters).`,
    input ? `Input: ${input}.` : "",
    "Use result_ref for the exact redacted output.",
  ].filter(Boolean).join(" ");
}

function parseLookupArgs(args) {
  const opts = { query: "", limit: 10, content: false, json: false, all: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--query") opts.query = args[++i] || "";
    else if (arg === "--limit") opts.limit = clampLimit(Number(args[++i] || 10), 10, 50);
    else if (arg === "--content" || arg === "--full") opts.content = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--all") opts.all = true;
    else throw new Error(`Unknown offload option: ${arg}`);
  }
  return opts;
}

function offloadUsage(code) {
  const message = `Usage:
  node scripts/query.mjs offload list [--all] [--query <text>] [--limit <n>]
  node scripts/query.mjs offload node <node_id|tool_call_id> [--content] [--json]
  node scripts/query.mjs offload canvas
`;
  (code === 0 ? console.log : console.error)(message);
  process.exit(code);
}

function entryMatchesQuery(entry, query) {
  return [
    entry.node_id,
    entry.tool_call_id,
    entry.tool_call,
    entry.summary,
    entry.result_ref,
    entry.codex?.tool_name,
    entry.codex?.cwd,
  ].filter(Boolean).join("\n").toLowerCase().includes(query);
}

async function readFileIfExists(filePath, maxChars) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return truncate(content, maxChars);
  } catch {
    return "";
  }
}

function tdaiDataDir() {
  const configured =
    process.env.TDAI_CODEX_DATA_DIR ||
    process.env.TDAI_DATA_DIR ||
    path.join(os.homedir(), ".memory-tencentdb", "codex-memory-tdai");
  return path.resolve(expandHome(configured));
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function safeKey(value) {
  return String(value).replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120);
}

function optionalLower(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "";
}

function normalizePath(value) {
  return typeof value === "string" && value.trim()
    ? path.resolve(expandHome(value.trim()))
    : "";
}

function clampLimit(value, fallback, max) {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function numericEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function singleLine(value, maxChars) {
  const flattened = String(value || "").replace(/\s+/g, " ").trim();
  if (!maxChars || flattened.length <= maxChars) return flattened;
  return `${flattened.slice(0, maxChars)}...`;
}

function toolNameFromCall(value) {
  return String(value || "tool").split(":")[0].trim() || "tool";
}

function previewHeadTail(value, chars) {
  const str = String(value ?? "");
  if (str.length <= chars * 2 + 200) return str;
  return [
    str.slice(0, chars),
    `\n[...omitted ${str.length - chars * 2} chars; full redacted output is stored on disk...]\n`,
    str.slice(-chars),
  ].join("");
}

export function previewForPolicy(value, policy) {
  return previewHeadTail(value, policy?.previewChars ?? DEFAULT_TOOL_OFFLOAD_PREVIEW_CHARS);
}

function stripMermaidFence(value) {
  return String(value || "")
    .replace(/^```mermaid\s*/i, "")
    .replace(/```\s*$/i, "");
}

function truncate(value, maxChars) {
  const str = String(value ?? "");
  if (!maxChars || str.length <= maxChars) return str;
  return `${str.slice(0, maxChars)}\n[...truncated ${str.length - maxChars} chars]`;
}

async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await fs.chmod(dir, PRIVATE_DIR_MODE);
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
}

async function writePrivateFile(file, content) {
  await ensurePrivateDir(path.dirname(file));
  await fs.writeFile(file, content, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
  await chmodPrivateFile(file);
}

async function chmodPrivateFile(file) {
  try {
    await fs.chmod(file, PRIVATE_FILE_MODE);
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
}

function escapeText(value) {
  return String(value).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}

function escapeMermaidLabel(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/\n/g, "<br/>");
}
