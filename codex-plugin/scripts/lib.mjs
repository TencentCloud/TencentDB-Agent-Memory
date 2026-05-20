import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  buildCodexOffloadContext,
  maxStoreChars as offloadMaxStoreChars,
  previewForPolicy,
  recordCodexToolOffload,
  selectToolOffloadPolicy
} from "./offload-store.mjs";
import { isLoopbackHost } from "./loopback.mjs";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";
const DEFAULT_CONTEXT_MAX_CHARS = 12000;
const DEFAULT_RECALL_TIMEOUT_MS = 5000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 8000;
const DEFAULT_HEALTH_TIMEOUT_MS = 700;
const DEFAULT_START_TIMEOUT_MS = 12000;
const DEFAULT_SESSION_END_TIMEOUT_MS = 8000;
const DEFAULT_BREAKER_FAILURE_THRESHOLD = 5;
const DEFAULT_BREAKER_COOLDOWN_MS = 60_000;
const DEFAULT_FLUSH_EVERY_N_TURNS = 5;
const DEFAULT_TOOL_OFFLOAD_CONTEXT_CHARS = 6_000;
const DEFAULT_GATEWAY_PACKAGE = "@tencentdb-agent-memory/memory-tencentdb";
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const execFileAsync = promisify(execFile);
const INJECTED_MEMORY_TAGS = [
  "tdai-codex-memory-context",
  "structured-memory-results",
  "tdai-recall-context",
  "raw-conversation-results",
  "tdai-codex-context-offload",
  "tdai-codex-tool-memory-hint",
  "tdai-codex-tool-output-offload",
  "relevant-memories",
  "user-persona",
  "relevant-scenes",
  "scene-navigation",
  "memory-tools-guide",
  "current_task_context",
  "history_task_context",
];
const SENSITIVE_JSON_KEY = "[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|password|authorization)[A-Za-z0-9_-]*";
const REDACTION_PATTERNS = Object.freeze({
  privateKey: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  authorizationLine: /(^|[\r\n])(\s*(?:proxy-)?authorization\s*[:=]\s*)[^\r\n]*/gi,
  bearer: /Bearer\s+[A-Za-z0-9._~+/-]+=*/g,
  gatewayToken: /(\bgateway[-_\s]?token\b[^A-Za-z0-9_-]{0,20})[A-Za-z0-9_-]{43}\b/gi,
  openAiKey: /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  githubPat: /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  githubToken: /\b(gh[pousr]_[A-Za-z0-9_]{30,})\b/g,
  slackToken: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  awsAccessKey: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
  jsonDouble: new RegExp(`(["'])(${SENSITIVE_JSON_KEY})\\1\\s*:\\s*"[^"]*"`, "gi"),
  jsonSingle: new RegExp(`(["'])(${SENSITIVE_JSON_KEY})\\1\\s*:\\s*'[^']*'`, "gi"),
  jsonBare: new RegExp(`(["'])(${SENSITIVE_JSON_KEY})\\1\\s*:\\s*[^,}\\]\\s]+`, "gi"),
  envLike: new RegExp(`\\b(${SENSITIVE_JSON_KEY})\\b\\s*[:=]\\s*['"]?[^'\"\\s,}]+`, "gi"),
});

export function pluginRoot() {
  const configured = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT;
  return configured
    ? path.resolve(configured)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function tdaiDataDir() {
  const configured =
    process.env.TDAI_CODEX_DATA_DIR ||
    process.env.TDAI_DATA_DIR ||
    path.join(os.homedir(), ".memory-tencentdb", "codex-memory-tdai");
  return path.resolve(expandHome(configured));
}

export function hookLogPath() {
  return path.join(tdaiDataDir(), "codex-adapter", "logs", "hook.log");
}

export function gatewayStdoutLogPath() {
  return path.join(tdaiDataDir(), "codex-adapter", "logs", "gateway.stdout.log");
}

export function gatewayStderrLogPath() {
  return path.join(tdaiDataDir(), "codex-adapter", "logs", "gateway.stderr.log");
}

export function gatewayUrl() {
  return (process.env.TDAI_CODEX_GATEWAY_URL || DEFAULT_GATEWAY_URL).replace(/\/+$/, "");
}

export function gatewayHostPort() {
  const url = new URL(gatewayUrl());
  return {
    host: process.env.TDAI_GATEWAY_HOST || url.hostname || "127.0.0.1",
    port: process.env.TDAI_GATEWAY_PORT || url.port || "8420"
  };
}

export function resolveTdaiRoot() {
  const root = pluginRoot();
  const candidates = [
    process.env.TDAI_CODEX_TDAI_ROOT,
    process.env.TDAI_INSTALL_DIR,
    path.join(root, ".."),
    path.join(root, "vendor", "TencentDB-Agent-Memory"),
    path.join(process.cwd(), "TencentDB-Agent-Memory")
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(expandHome(candidate));
    const pkg = path.join(resolved, "package.json");
    const gateway = path.join(resolved, "src", "gateway", "server.ts");
    if (!fsSync.existsSync(pkg) || !fsSync.existsSync(gateway)) continue;
    try {
      const parsed = JSON.parse(fsSync.readFileSync(pkg, "utf-8"));
      if (parsed.name === "@tencentdb-agent-memory/memory-tencentdb") {
        return resolved;
      }
    } catch {
      return resolved;
    }
  }
  return null;
}

export async function readHookInput() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return {};
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

export function cwdFromPayload(payload) {
  return path.resolve(
    payload.cwd ||
    payload.project ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd()
  );
}

export function sessionIdFromPayload(payload) {
  return String(payload.session_id || payload.sessionId || payload.session || "unknown-session");
}

export function promptFromPayload(payload) {
  const directPrompt = firstNonEmptyText([
    payload.prompt,
    payload.user_prompt,
    payload.userPrompt,
    payload.message,
    payload.input,
    payload.payload
  ]);
  return directPrompt || transcriptPromptFromPayload(payload);
}

function firstNonEmptyText(values) {
  for (const value of values) {
    const text = textFromCodexContent(value).trim();
    if (text) return text;
  }
  return "";
}

function textFromCodexContent(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map(textFromCodexContent).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    if (value.type === "message") {
      return value.role === "user" ? textFromCodexContent(value.content) : "";
    }
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string" || Array.isArray(value.content)) {
      return textFromCodexContent(value.content);
    }
  }
  return "";
}

function transcriptPromptFromPayload(payload) {
  const transcriptPath = payload.transcript_path || payload.transcriptPath;
  if (!transcriptPath || typeof transcriptPath !== "string") return "";
  return latestUserPromptFromTranscript(transcriptPath);
}

function latestUserPromptFromTranscript(transcriptPath) {
  try {
    const resolved = path.resolve(expandHome(transcriptPath));
    const stat = fsSync.statSync(resolved);
    if (!stat.isFile() || stat.size === 0) return "";
    const maxBytes = 1_000_000;
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fsSync.openSync(resolved, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fsSync.readSync(fd, buffer, 0, buffer.length, start);
      const chunk = buffer.toString("utf-8");
      const lines = chunk.slice(start === 0 ? 0 : chunk.indexOf("\n") + 1).trimEnd().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const text = userPromptFromTranscriptLine(lines[i]);
        if (text && !isSyntheticUserPrompt(text)) return text;
      }
    } finally {
      fsSync.closeSync(fd);
    }
  } catch {
    return "";
  }
  return "";
}

function userPromptFromTranscriptLine(line) {
  if (!line?.trim()) return "";
  try {
    const entry = JSON.parse(line);
    const payload = entry?.payload;
    if (!payload || payload.type !== "message" || payload.role !== "user") return "";
    return textFromCodexContent(payload.content).trim();
  } catch {
    return "";
  }
}

function isSyntheticUserPrompt(text) {
  const trimmed = text.trim();
  return trimmed.startsWith("<turn_aborted>") || trimmed.startsWith("<tdai-codex-");
}

function isSyntheticAssistantText(text) {
  const trimmed = text.trim();
  return trimmed === "NO_REPLY" ||
    trimmed.startsWith("<turn_aborted>") ||
    trimmed.startsWith("<tdai-codex-") ||
    /^✅\s*New session started/.test(trimmed) ||
    /^Pre-compaction memory flush/i.test(trimmed);
}

export function sessionKeyFromPayload(payload) {
  const cwd = cwdFromPayload(payload);
  const sessionId = sessionIdFromPayload(payload);
  return `codex:${sha1(cwd).slice(0, 10)}:${safeKey(sessionId)}`;
}

export function sessionKeyPrefixesForCwd(cwd) {
  const cwdHash = sha1(path.resolve(expandHome(cwd))).slice(0, 10);
  return [
    `codex:${cwdHash}:`,
    `codex-import:${cwdHash}:`
  ];
}

export function projectLabel(payload) {
  const cwd = cwdFromPayload(payload);
  return `${path.basename(cwd)} (${cwd})`;
}

export function sha1(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function safeKey(value) {
  return String(value).replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120);
}

function statePath(sessionKey) {
  return path.join(tdaiDataDir(), "codex-adapter", "sessions", `${sha1(sessionKey)}.json`);
}

async function ensureStateDir() {
  await ensurePrivateDir(path.join(tdaiDataDir(), "codex-adapter", "sessions"));
}

function gatewayCircuitPath() {
  return path.join(tdaiDataDir(), "codex-adapter", "gateway-circuit.json");
}

export async function loadSessionState(sessionKey) {
  await ensureStateDir();
  const file = statePath(sessionKey);
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    return { sessionKey, turns: [] };
  }
}

export async function saveSessionState(sessionKey, state) {
  await ensureStateDir();
  const file = statePath(sessionKey);
  const tmp = `${file}.${process.pid}.tmp`;
  await writePrivateFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(tmp, file);
  await chmodPrivateFile(file);
}

export async function beginTurn(payload) {
  const sessionKey = sessionKeyFromPayload(payload);
  const state = await loadSessionState(sessionKey);
  const prompt = sanitizeMemoryText(promptFromPayload(payload));
  const now = Date.now();

  if (state.currentTurn && !state.currentTurn.captured) {
    state.turns = state.turns || [];
    state.turns.push({
      ...state.currentTurn,
      abandonedAt: now,
      abandonedReason: "new_user_prompt_before_stop"
    });
  }

  state.currentTurn = {
    turnId: `turn_${now}_${crypto.randomBytes(3).toString("hex")}`,
    sessionKey,
    sessionId: sessionIdFromPayload(payload),
    cwd: cwdFromPayload(payload),
    project: projectLabel(payload),
    userPrompt: prompt,
    startedAt: now,
    events: [
      {
        phase: "user_prompt",
        timestamp: now,
        content: sanitizeMemoryText(prompt)
      }
    ],
    captured: false
  };

  await saveSessionState(sessionKey, state);
  return state.currentTurn;
}

export async function appendToolEvent(payload, phase, extra = {}) {
  const sessionKey = sessionKeyFromPayload(payload);
  const state = await loadSessionState(sessionKey);
  const now = Date.now();
  if (!state.currentTurn) {
    state.currentTurn = {
      turnId: `turn_${now}_${crypto.randomBytes(3).toString("hex")}`,
      sessionKey,
      sessionId: sessionIdFromPayload(payload),
      cwd: cwdFromPayload(payload),
      project: projectLabel(payload),
      userPrompt: "",
      startedAt: now,
      events: [],
      captured: false
    };
  }

  state.currentTurn.events.push({
    phase,
    timestamp: now,
    toolName: payload.tool_name || payload.toolName || "",
    toolInput: compact(payload.tool_input ?? payload.toolInput ?? payload.input, 2500),
    toolOutput: compact(toolOutputFromPayload(payload), 4000),
    ...sanitizeEventDetail(extra)
  });
  await saveSessionState(sessionKey, state);
}

export async function appendLifecycleEvent(payload, phase, detail = {}, options = {}) {
  const sessionKey = sessionKeyFromPayload(payload);
  const state = await loadSessionState(sessionKey);
  const now = Date.now();
  if (!state.currentTurn) {
    if (options.createTurn === false) {
      return { appended: false, reason: "no_pending_turn" };
    }
    state.currentTurn = {
      turnId: `turn_${now}_${crypto.randomBytes(3).toString("hex")}`,
      sessionKey,
      sessionId: sessionIdFromPayload(payload),
      cwd: cwdFromPayload(payload),
      project: projectLabel(payload),
      userPrompt: "",
      startedAt: now,
      events: [],
      captured: false
    };
  }
  state.currentTurn.events.push({
    phase,
    timestamp: now,
    ...sanitizeEventDetail(detail)
  });
  await saveSessionState(sessionKey, state);
  return { appended: true };
}

export async function captureCurrentTurn(payload, reason = "stop") {
  const sessionKey = sessionKeyFromPayload(payload);
  const state = await loadSessionState(sessionKey);
  const turn = state.currentTurn;
  if (!turn || turn.captured) return { captured: false, reason: "no_pending_turn" };

  const gatewayReady = await ensureGateway();
  if (!gatewayReady) return { captured: false, reason: "gateway_unavailable" };

  const userContent = buildUserContent(turn, payload, reason);
  const assistantContent =
    await extractAssistantFromTranscript(payload.transcript_path, turn.startedAt)
    || buildAssistantSummary(turn, reason);

  const messages = [
    { role: "user", content: userContent, timestamp: turn.startedAt },
    { role: "assistant", content: assistantContent, timestamp: Date.now() }
  ];

  const response = await httpPost("/capture", {
    user_content: userContent,
    assistant_content: assistantContent,
    session_key: sessionKey,
    session_id: turn.sessionId,
    started_at: Math.max(0, turn.startedAt - 1),
    messages
  }, DEFAULT_CAPTURE_TIMEOUT_MS);

  if (!response) {
    turn.lastCaptureFailure = {
      reason,
      failedAt: Date.now()
    };
    await saveSessionState(sessionKey, state);
    return {
      captured: false,
      reason: "capture_failed"
    };
  }

  turn.captured = true;
  turn.capturedAt = Date.now();
  turn.captureReason = reason;
  turn.captureResponse = {
    l0_recorded: response.l0_recorded,
    scheduler_notified: response.scheduler_notified
  };

  state.turns = state.turns || [];
  state.turns.push(turn);
  delete state.currentTurn;
  await saveSessionState(sessionKey, state);

  return {
    captured: true,
    l0Recorded: response?.l0_recorded ?? 0,
    schedulerNotified: response?.scheduler_notified ?? false,
    turnCount: state.turns.length
  };
}

export async function maybeFlushCapturedTurns(payload, captureResult, reason = "periodic_turn_flush") {
  if (!captureResult?.captured) return { flushed: false, reason: "no_capture" };
  const interval = numericEnv("TDAI_CODEX_FLUSH_EVERY_N_TURNS", DEFAULT_FLUSH_EVERY_N_TURNS);
  if (!Number.isFinite(interval) || interval <= 0) return { flushed: false, reason: "disabled" };

  const sessionKey = sessionKeyFromPayload(payload);
  const state = await loadSessionState(sessionKey);
  const turnCount = Array.isArray(state.turns) ? state.turns.length : 0;
  if (turnCount === 0 || turnCount % interval !== 0 || state.lastPeriodicFlushTurnCount === turnCount) {
    return { flushed: false, reason: "not_due", turnCount, interval };
  }

  const result = await sessionEnd(payload, reason);
  state.lastPeriodicFlushTurnCount = turnCount;
  state.lastPeriodicFlushAt = Date.now();
  state.lastPeriodicFlushResult = result;
  await saveSessionState(sessionKey, state);
  return { ...result, turnCount, interval };
}

function buildUserContent(turn, payload, reason) {
  const prompt = sanitizeMemoryText(turn.userPrompt || promptFromPayload(payload)) || "[Codex turn without captured user prompt]";
  return [
    `Codex project: ${turn.project || projectLabel(payload)}`,
    `Codex session: ${turn.sessionId || sessionIdFromPayload(payload)}`,
    `Capture reason: ${reason}`,
    "",
    "User request:",
    prompt
  ].join("\n");
}

function buildAssistantSummary(turn, reason) {
  const lines = [
    `Codex turn completed. Capture reason: ${reason}.`,
    `Project: ${turn.project || turn.cwd || ""}`,
    ""
  ];

  const events = Array.isArray(turn.events) ? turn.events : [];
  const toolEvents = events.filter((event) => event.phase === "pre_tool_use" || event.phase === "post_tool_use");
  if (toolEvents.length === 0) {
    lines.push("No tool events were available from Codex hooks for this turn.");
  } else {
    lines.push("Captured tool activity:");
    for (const event of toolEvents.slice(-20)) {
      lines.push(`- ${event.phase}: ${event.toolName || "(unknown tool)"}`);
      if (event.toolInput) lines.push(indentBlock(`input: ${event.toolInput}`, "  "));
      if (event.toolOutput) lines.push(indentBlock(`output: ${event.toolOutput}`, "  "));
    }
  }

  return truncate(sanitizeMemoryText(lines.join("\n")), 10000);
}

export async function recallForPrompt(payload, prompt, mode = "prompt") {
  const sessionKey = sessionKeyFromPayload(payload);
  const cwd = cwdFromPayload(payload);
  const cleanPrompt = sanitizeMemoryText(prompt || "");
  const offloadContextPromise = buildCodexOffloadContext({
    sessionKey,
    sessionId: sessionIdFromPayload(payload),
    maxChars: numericEnv("TDAI_CODEX_TOOL_OFFLOAD_CONTEXT_CHARS", DEFAULT_TOOL_OFFLOAD_CONTEXT_CHARS)
  });

  const gatewayReady = await ensureGateway();
  const query = [
    `Codex project cwd: ${cwd}`,
    `Recall mode: ${mode}`,
    "",
    cleanPrompt.trim()
      ? `Current user request:\n${cleanPrompt.trim()}`
      : "Session startup/resume: recover project state, active decisions, pending tasks, and user preferences."
  ].join("\n");

  const [recall, memories, conversations] = gatewayReady
    ? await Promise.all([
      httpPost("/recall", { query, session_key: sessionKey }, DEFAULT_RECALL_TIMEOUT_MS),
      httpPost("/search/memories", {
        query,
        limit: numericEnv("TDAI_CODEX_MEMORY_LIMIT", 8),
        session_key_prefixes: sessionKeyPrefixesForCwd(cwd)
      }, DEFAULT_RECALL_TIMEOUT_MS),
      shouldSearchConversations(cleanPrompt, mode)
        ? httpPost("/search/conversations", {
          query,
          limit: numericEnv("TDAI_CODEX_CONVERSATION_LIMIT", 5),
          session_key_prefixes: sessionKeyPrefixesForCwd(cwd)
        }, DEFAULT_RECALL_TIMEOUT_MS)
        : Promise.resolve(null)
    ])
    : [null, null, null];
  const directConversations = !hasUsefulGatewayText(memories?.results) &&
    !recall?.context?.trim() &&
    !hasUsefulGatewayText(conversations?.results) &&
    cleanPrompt.trim()
    ? await searchL0JsonlDirect({
      query: cleanPrompt,
      cwd,
      limit: numericEnv("TDAI_CODEX_DIRECT_L0_LIMIT", 3)
    })
    : "";

  const parts = [];
  if (hasUsefulGatewayText(memories?.results)) {
    parts.push(`<structured-memory-results strategy="${escapeAttr(memories.strategy || "unknown")}" total="${memories.total ?? ""}">\n${memories.results.trim()}\n</structured-memory-results>`);
  }
  if (recall?.context?.trim()) {
    parts.push(`<tdai-recall-context>\n${recall.context.trim()}\n</tdai-recall-context>`);
  }
  if (hasUsefulGatewayText(conversations?.results)) {
    parts.push(`<raw-conversation-results total="${conversations.total ?? ""}">\n${conversations.results.trim()}\n</raw-conversation-results>`);
  }
  if (directConversations) {
    parts.push(`<raw-conversation-results source="local-jsonl-direct">\n${directConversations}\n</raw-conversation-results>`);
  }
  const offloadContext = await offloadContextPromise;
  if (offloadContext) {
    parts.push(offloadContext);
  }

  if (parts.length === 0) return "";

  const context = `<tdai-codex-memory-context project="${escapeAttr(projectLabel(payload))}">
Use retrieved memory as operating context; verify drift-prone facts; persist durable new decisions.
${parts.join("\n\n")}
</tdai-codex-memory-context>`;

  return truncate(context, numericEnv("TDAI_CODEX_CONTEXT_MAX_CHARS", DEFAULT_CONTEXT_MAX_CHARS));
}

export function hookAdditionalContext(hookEventName, context) {
  if (!context?.trim()) return "";
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
      additionalContext: context
    }
  })}\n`;
}

export function toolMemoryHint(payload) {
  const toolName = payload.tool_name || payload.toolName || "";
  if (!toolName) return "";
  const input = compact(payload.tool_input ?? payload.toolInput ?? payload.input, 1200);
  return `<tdai-codex-tool-memory-hint>
Use injected memory/MCP search for prior decisions or exact history; use tdai_offload_lookup for offload node_id refs.
Tool: ${escapeText(toolName)}${input ? `\nInput: ${escapeText(input)}` : ""}
</tdai-codex-tool-memory-hint>`;
}

export async function maybeOffloadToolOutput(payload) {
  if (process.env.TDAI_CODEX_TOOL_OFFLOAD === "false") return null;

  const rawOutput = toolOutputFromPayload(payload);
  const rendered = renderToolValue(rawOutput);
  if (!rendered.trim()) return null;

  const redacted = redact(rendered);
  const policy = selectToolOffloadPolicy(redacted.length);
  if (!policy) return null;

  const sessionKey = sessionKeyFromPayload(payload);
  const sessionId = sessionIdFromPayload(payload);
  const cwd = cwdFromPayload(payload);
  const toolName = payload.tool_name || payload.toolName || "unknown-tool";
  const toolUseId = payload.tool_use_id || payload.toolUseId || `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const maxStoreChars = offloadMaxStoreChars();
  const storedText = truncate(redacted, maxStoreChars);
  const inputSummary = compact(payload.tool_input ?? payload.toolInput ?? payload.input, 5000);
  const recorded = await recordCodexToolOffload({
    sessionKey,
    sessionId,
    cwd,
    toolName,
    toolUseId,
    inputSummary,
    redactedOutput: redacted,
    storedText,
    policy
  });

  const preview = previewForPolicy(redacted, policy);
  const nodeId = recorded.entry.node_id || "pending";
  const outputPath = path.join(recorded.paths.root, recorded.entry.result_ref);
  const summary = [
    "TencentDB Agent Memory offloaded this large tool result to keep Codex context compact.",
    `Tool: ${toolName}`,
    `Tool use id: ${toolUseId}`,
    `Node id: ${nodeId}`,
    `Offload policy: ${policy.name}`,
    `Original output size after redaction: ${redacted.length} characters.`,
    `Stored output path: ${outputPath}`,
    `Offload JSONL: ${recorded.paths.offloadJsonl}`,
    `Mermaid canvas: ${recorded.paths.canvasPath}`,
    "",
    "Use tdai_offload_lookup with the node id or tool use id for exact audit details.",
    "Use tdai_memory_search / tdai_conversation_search for later long-term recall.",
    "",
    "Preview:",
    preview
  ].join("\n");

  return {
    outputPath,
    nodeId,
    toolUseId,
    policy: policy.name,
    offloadJsonlPath: recorded.paths.offloadJsonl,
    canvasPath: recorded.paths.canvasPath,
    originalChars: redacted.length,
    storedChars: storedText.length,
    summary: truncate(summary, numericEnv("TDAI_CODEX_TOOL_OFFLOAD_SUMMARY_MAX_CHARS", 7000))
  };
}

export function postToolOffloadHookOutput(offload) {
  if (!offload) return "";
  return `${JSON.stringify({
    decision: "block",
    reason: offload.summary,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `<tdai-codex-tool-output-offload>
<node-id>${escapeText(offload.nodeId || "")}</node-id>
<policy>${escapeText(offload.policy || "")}</policy>
${escapeText(offload.summary)}
</tdai-codex-tool-output-offload>`
    }
  })}\n`;
}

function shouldSearchConversations(prompt, mode) {
  if (mode === "session-start") return true;
  if (!prompt) return false;
  return /(继续|上次|之前|刚才|resume|continue|previous|last time|where were we|做到哪)/i.test(prompt);
}

async function searchL0JsonlDirect(params) {
  const { query, cwd, limit } = params;
  const keywords = queryKeywords(query);
  if (keywords.length === 0) return "";

  const conversationsDir = path.join(tdaiDataDir(), "conversations");
  let entries;
  try {
    entries = await fs.readdir(conversationsDir, { withFileTypes: true });
  } catch {
    return "";
  }

  const files = (await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map(async (entry) => {
      const file = path.join(conversationsDir, entry.name);
      try {
        const stat = await fs.stat(file);
        return { file, mtimeMs: stat.mtimeMs };
      } catch {
        return { file, mtimeMs: 0 };
      }
    })))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, numericEnv("TDAI_CODEX_DIRECT_L0_MAX_FILES", 30));

  const prefixes = sessionKeyPrefixesForCwd(cwd);
  const matches = [];
  const seen = new Set();

  for (const { file } of files) {
    let stream;
    try {
      stream = fsSync.createReadStream(file, { encoding: "utf-8" });
    } catch {
      continue;
    }

    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const sessionKey = typeof row.sessionKey === "string" ? row.sessionKey : "";
        if (!prefixes.some((prefix) => sessionKey.startsWith(prefix))) continue;
        const content = sanitizeMemoryText(row.content || row.message_text || "");
        if (!content) continue;
        const lower = content.toLowerCase();
        const hits = keywords.filter((keyword) => lower.includes(keyword)).length;
        if (hits === 0) continue;
        const fingerprint = `${row.role || ""}:${content.slice(0, 180)}`;
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        matches.push({
          role: row.role || "unknown",
          content: truncate(content, 2000),
          recordedAt: row.recordedAt || row.recorded_at || "",
          hits
        });
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  if (matches.length === 0) return "";
  matches.sort((a, b) =>
    rolePriority(b.role) - rolePriority(a.role) ||
    b.hits - a.hits ||
    b.content.length - a.content.length
  );

  const lines = [`Found ${Math.min(matches.length, limit)} matching local L0 conversation message(s):`, ""];
  for (const match of matches.slice(0, limit)) {
    lines.push("---");
    lines.push(`**[${match.role}]** ${match.recordedAt}`);
    lines.push("");
    lines.push(match.content);
    lines.push("");
  }
  return lines.join("\n");
}

function queryKeywords(value) {
  const cjkStop = new Set([
    "之前", "前聊", "聊的", "还记", "记得", "得么", "得吗",
    "一下", "怎么", "什么", "关于", "知道", "以前", "上次",
    "如何", "为何", "为啥", "哪里", "哪些", "为什",
    "请问", "请帮", "帮我", "麻烦"
  ]);
  const keywords = [];
  for (const segment of String(value || "").toLowerCase().replace(/[^\w一-鿿]/g, " ").split(/\s+/)) {
    if (!segment) continue;
    if (/[一-鿿]/.test(segment)) {
      for (let i = 0; i <= segment.length - 2; i++) {
        const gram = segment.slice(i, i + 2);
        if (!cjkStop.has(gram)) keywords.push(gram);
      }
    } else if (segment.length >= 2) {
      keywords.push(segment);
    }
  }
  return [...new Set(keywords)].slice(0, 40);
}

function rolePriority(role) {
  return role === "assistant" ? 1 : 0;
}

function hasUsefulGatewayText(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return !/^No matching (memories|conversations) found\.?$/i.test(text);
}

export async function ensureGateway() {
  if (await healthCheck()) return true;
  if (process.env.TDAI_CODEX_AUTOSTART === "false") return false;

  const started = await startGatewayDetached();
  if (!started) return false;

  const deadline = Date.now() + numericEnv("TDAI_CODEX_START_TIMEOUT_MS", DEFAULT_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await delay(500);
    if (await healthCheck()) return true;
  }
  return false;
}

export async function healthCheck() {
  if (!isAllowedGatewayEndpoint()) return false;
  try {
    const headers = await gatewayAuthHeaders();
    const res = await fetch(`${gatewayUrl()}/health`, {
      headers,
      signal: AbortSignal.timeout(DEFAULT_HEALTH_TIMEOUT_MS)
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startGatewayDetached() {
  const { host, port } = gatewayHostPort();
  if (!isLoopbackHost(host) && process.env.TDAI_CODEX_ALLOW_NON_LOOPBACK !== "true") {
    debug(`Refusing to autostart gateway on non-loopback host=${host}. Set TDAI_CODEX_ALLOW_NON_LOOPBACK=true to override.`);
    return false;
  }

  const logDir = path.dirname(hookLogPath());
  await ensurePrivateDir(logDir);
  const lock = await acquireGatewaySpawnLock(logDir);
  if (!lock) {
    const deadline = Date.now() + numericEnv("TDAI_CODEX_START_TIMEOUT_MS", DEFAULT_START_TIMEOUT_MS);
    while (Date.now() < deadline) {
      await delay(500);
      if (await healthCheck()) return true;
    }
    debug("Gateway spawn lock contention timed out");
    return false;
  }

  try {
    await ensureGatewayAuthToken();
    if (await healthCheck()) return true;
    const outFd = fsSync.openSync(gatewayStdoutLogPath(), "a", PRIVATE_FILE_MODE);
    const errFd = fsSync.openSync(gatewayStderrLogPath(), "a", PRIVATE_FILE_MODE);
    const pidFile = path.join(logDir, "gateway.pid");
    const pidMetadataFile = path.join(logDir, "gateway.pid.json");
    const launch = gatewayLaunchSpec();

    const env = {
      ...process.env,
      TDAI_DATA_DIR: tdaiDataDir(),
      TDAI_GATEWAY_CONFIG: process.env.TDAI_GATEWAY_CONFIG || path.join(tdaiDataDir(), "tdai-gateway.json"),
      TDAI_GATEWAY_HOST: host,
      TDAI_GATEWAY_PORT: port,
      TDAI_TOKEN_PATH: configuredGatewayTokenPath(),
      TDAI_CODEX_PARENT_PID: String(process.ppid || process.pid)
    };
    delete env.TDAI_GATEWAY_TOKEN;
    delete env.TDAI_CODEX_GATEWAY_TOKEN;

    if (launch.mode !== "package-bin" || process.env.TDAI_CODEX_HYDRATE_ENV_FOR_PACKAGE_GATEWAY === "true") {
      await hydrateLoginShellEnv(env, [
        "DEEPSEEK_API_KEY",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "TDAI_LLM_API_KEY",
        "TDAI_LLM_BASE_URL",
        "TDAI_LLM_MODEL"
      ]);
    }

    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      detached: true,
      env,
      stdio: ["ignore", outFd, errFd]
    });
    const spawnError = await detectSpawnError(child);
    if (spawnError || !child.pid) {
      debug(`Gateway spawn failed (${launch.mode}): ${spawnError?.message || "child has no pid"}`);
      return false;
    }
    child.unref();
    await writePrivateFile(pidFile, `${child.pid}\n`);
    await writePrivateFile(pidMetadataFile, `${JSON.stringify({
      pid: child.pid,
      root: launch.root,
      command: [launch.command, ...launch.args],
      launchMode: launch.mode,
      startedAt: new Date().toISOString()
    }, null, 2)}\n`);
    debug(`Started TDAI gateway pid=${child.pid} mode=${launch.mode}`);

    const deadline = Date.now() + numericEnv("TDAI_CODEX_START_TIMEOUT_MS", DEFAULT_START_TIMEOUT_MS);
    while (Date.now() < deadline) {
      await delay(500);
      if (await healthCheck()) return true;
    }
    debug(`Gateway did not become healthy after spawn mode=${launch.mode}`);
    return false;
  } finally {
    await lock.release();
  }
}

function detectSpawnError(child) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 50);
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve(err);
    });
  });
}

function gatewayLaunchSpec() {
  const override = process.env.TDAI_CODEX_GATEWAY_COMMAND || process.env.TDAI_GATEWAY_COMMAND;
  if (override) {
    return {
      command: override,
      args: [],
      cwd: tdaiDataDir(),
      root: "",
      mode: "override"
    };
  }

  const explicitRoot = process.env.TDAI_CODEX_TDAI_ROOT || process.env.TDAI_INSTALL_DIR;
  const root = explicitRoot ? resolveTdaiRoot() : null;
  if (root && fsSync.existsSync(path.join(root, "node_modules", "tsx"))) {
    return {
      command: "npx",
      args: ["tsx", "src/gateway/server.ts"],
      cwd: root,
      root,
      mode: "local-checkout"
    };
  }

  return {
    command: "npx",
    args: ["--yes", "--ignore-scripts", "--package", gatewayPackageSpec(), "tdai-memory-gateway"],
    cwd: tdaiDataDir(),
    root: "",
    mode: "package-bin"
  };
}

function gatewayPackageSpec() {
  return process.env.TDAI_CODEX_GATEWAY_PACKAGE || DEFAULT_GATEWAY_PACKAGE;
}

async function acquireGatewaySpawnLock(logDir) {
  const lockPath = path.join(logDir, "gateway.spawn.lock");
  const tryCreate = async () => {
    try {
      const handle = await fs.open(lockPath, "wx", PRIVATE_FILE_MODE);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return {
        release: async () => {
          await fs.rm(lockPath, { force: true });
        }
      };
    } catch (err) {
      if (err?.code === "EEXIST") return null;
      throw err;
    }
  };

  const first = await tryCreate();
  if (first) return first;

  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs > 60_000) {
      await fs.rm(lockPath, { force: true });
      return tryCreate();
    }
  } catch {
    return tryCreate();
  }
  return null;
}

export async function stopGateway() {
  const logDir = path.join(tdaiDataDir(), "codex-adapter", "logs");
  const pidInfo = await readGatewayPidInfo(logDir);
  if (!pidInfo) return false;

  if (!(await pidLooksLikeGateway(pidInfo.pid))) {
    debug(`Refusing to stop pid=${pidInfo.pid}: process does not look like TDAI gateway`);
    return false;
  }

  try {
    process.kill(pidInfo.pid, "SIGTERM");
    await removeGatewayPidFiles(logDir);
    return true;
  } catch {
    return false;
  }
}

async function readGatewayPidInfo(logDir) {
  const pidMetadataFile = path.join(logDir, "gateway.pid.json");
  try {
    const metadata = JSON.parse(await fs.readFile(pidMetadataFile, "utf-8"));
    const pid = Number(metadata.pid);
    if (Number.isFinite(pid) && pid > 0) return { ...metadata, pid };
  } catch {
    // Fall back to the legacy plain PID file below.
  }

  try {
    const pid = Number((await fs.readFile(path.join(logDir, "gateway.pid"), "utf-8")).trim());
    if (Number.isFinite(pid) && pid > 0) return { pid };
  } catch {
    return null;
  }
  return null;
}

async function pidLooksLikeGateway(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      timeout: 1000,
      maxBuffer: 4096
    });
    const command = stdout.trim();
    return command.includes("tdai-memory-gateway") ||
      (command.includes("tsx") && command.includes("src/gateway/server.ts"));
  } catch (err) {
    debug(`Could not inspect pid=${pid}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function removeGatewayPidFiles(logDir) {
  await Promise.all([
    fs.rm(path.join(logDir, "gateway.pid"), { force: true }),
    fs.rm(path.join(logDir, "gateway.pid.json"), { force: true })
  ]);
}

export async function httpPost(route, body, timeoutMs = DEFAULT_RECALL_TIMEOUT_MS) {
  if (!isAllowedGatewayEndpoint()) return null;
  if (await isGatewayCircuitOpen()) return null;
  try {
    if (timeoutMs > 300_000 || route === "/seed") {
      const json = await httpPostLong(route, body, timeoutMs);
      await recordGatewaySuccess();
      return json;
    }

    const headers = {
      "Content-Type": "application/json",
      ...await gatewayAuthHeaders()
    };
    const res = await fetch(`${gatewayUrl()}${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      debug(`Gateway ${route} returned ${res.status}: ${await res.text().catch(() => "")}`);
      await recordGatewayFailure(route);
      return null;
    }
    const json = await res.json();
    await recordGatewaySuccess();
    return json;
  } catch (err) {
    debug(`Gateway ${route} failed: ${err instanceof Error ? err.message : String(err)}`);
    await recordGatewayFailure(route);
    return null;
  }
}

async function httpPostLong(route, body, timeoutMs) {
  const url = new URL(`${gatewayUrl()}${route}`);
  const payload = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...await gatewayAuthHeaders()
  };
  const client = url.protocol === "https:" ? https : http;

  return await new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: "POST",
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          reject(new Error(`Gateway ${route} returned ${res.statusCode}: ${text}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : null);
        } catch (err) {
          reject(new Error(`Gateway ${route} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`Gateway ${route} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function isAllowedGatewayEndpoint() {
  let url;
  try {
    url = new URL(gatewayUrl());
  } catch {
    debug(`Refusing invalid Gateway URL: ${gatewayUrl()}`);
    return false;
  }
  if (isLoopbackHost(url.hostname)) return true;
  if (process.env.TDAI_CODEX_ALLOW_NON_LOOPBACK === "true") return true;
  debug(`Refusing non-loopback Gateway URL=${url.origin}. Set TDAI_CODEX_ALLOW_NON_LOOPBACK=true to override.`);
  return false;
}

async function isGatewayCircuitOpen() {
  if (process.env.TDAI_CODEX_CIRCUIT_BREAKER === "false") return false;
  const state = await readGatewayCircuit();
  const openedUntil = Number(state.openedUntil || 0);
  if (openedUntil > Date.now()) {
    debug(`Gateway circuit breaker open for ${Math.ceil((openedUntil - Date.now()) / 1000)}s`);
    return true;
  }
  if (openedUntil) {
    await writeGatewayCircuit({ failureCount: 0, openedUntil: 0, lastRoute: state.lastRoute || "" });
  }
  return false;
}

async function recordGatewayFailure(route) {
  if (process.env.TDAI_CODEX_CIRCUIT_BREAKER === "false") return;
  const state = await readGatewayCircuit();
  const threshold = numericEnv("TDAI_CODEX_BREAKER_FAILURES", DEFAULT_BREAKER_FAILURE_THRESHOLD);
  const cooldownMs = numericEnv("TDAI_CODEX_BREAKER_COOLDOWN_MS", DEFAULT_BREAKER_COOLDOWN_MS);
  const failureCount = Number(state.failureCount || 0) + 1;
  const openedUntil = failureCount >= threshold ? Date.now() + cooldownMs : Number(state.openedUntil || 0);
  await writeGatewayCircuit({
    failureCount,
    openedUntil,
    lastRoute: route,
    lastFailureAt: Date.now()
  });
  if (openedUntil) {
    debug(`Gateway circuit breaker opened after ${failureCount} failures; cooldown=${cooldownMs}ms`);
  }
}

async function recordGatewaySuccess() {
  if (process.env.TDAI_CODEX_CIRCUIT_BREAKER === "false") return;
  const state = await readGatewayCircuit();
  if (!state.failureCount && !state.openedUntil) return;
  await writeGatewayCircuit({ failureCount: 0, openedUntil: 0, lastSuccessAt: Date.now() });
}

async function readGatewayCircuit() {
  try {
    return JSON.parse(await fs.readFile(gatewayCircuitPath(), "utf-8"));
  } catch {
    return { failureCount: 0, openedUntil: 0 };
  }
}

async function writeGatewayCircuit(state) {
  const file = gatewayCircuitPath();
  await ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await writePrivateFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(tmp, file);
  await chmodPrivateFile(file);
}

async function extractAssistantFromTranscript(transcriptPath, sinceMs) {
  if (!transcriptPath || !fsSync.existsSync(transcriptPath)) return "";
  try {
    const stat = await fs.stat(transcriptPath);
    const maxBytes = numericEnv("TDAI_CODEX_TRANSCRIPT_TAIL_BYTES", 2_000_000);
    const fh = await fs.open(transcriptPath, "r");
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    await fh.read(buffer, 0, buffer.length, start);
    await fh.close();

    const candidates = [];
    for (const line of buffer.toString("utf-8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = timestampFromAny(parsed);
      if (sinceMs && ts && ts < sinceMs - 1000) continue;
      const text = extractAssistantText(parsed).trim();
      if (isSyntheticAssistantText(text)) continue;
      if (text.length > 20) candidates.push(text);
    }
    return truncate(sanitizeMemoryText(candidates.at(-1) || ""), 10000);
  } catch {
    return "";
  }
}

function timestampFromAny(value) {
  if (!value || typeof value !== "object") return 0;
  const direct = value.timestamp || value.created_at || value.createdAt;
  if (typeof direct === "number") return direct;
  if (typeof direct === "string") {
    const parsed = Date.parse(direct);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return timestampFromAny(value.item || value.message || value.payload || value.response);
}

function extractAssistantText(value) {
  if (!value) return "";
  if (typeof value === "string") return "";
  if (Array.isArray(value)) return value.map(extractAssistantText).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";

  const role = value.role || value.author?.role || value.message?.role || value.item?.role;
  const type = value.type;
  if ((role === "assistant" || type === "assistant_message") && value.content) {
    return contentToText(value.content);
  }
  if (type === "message" && role === "assistant" && value.content) {
    return contentToText(value.content);
  }
  if (type === "response_item" && value.item) return extractAssistantText(value.item);
  if (value.item) return extractAssistantText(value.item);
  if (value.message) return extractAssistantText(value.message);
  if (value.payload) return extractAssistantText(value.payload);
  if (value.response) return extractAssistantText(value.response);
  return "";
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

export async function rememberText(payload, text) {
  const gatewayReady = await ensureGateway();
  if (!gatewayReady) return { remembered: false, reason: "gateway_unavailable" };
  const now = Date.now();
  const sessionKey = sessionKeyFromPayload(payload);
  const content = [
    `Codex project: ${projectLabel(payload)}`,
    "Explicit memory note:",
    sanitizeMemoryText(text)
  ].join("\n");
  const response = await httpPost("/capture", {
    user_content: "Explicit memory note saved from Codex.",
    assistant_content: content,
    session_key: sessionKey,
    session_id: sessionIdFromPayload(payload),
    started_at: Math.max(0, now - 1),
    messages: [
      { role: "user", content: "Remember this.", timestamp: now },
      { role: "assistant", content, timestamp: now + 1 }
    ]
  }, DEFAULT_CAPTURE_TIMEOUT_MS);
  return { remembered: !!response, response };
}

export async function sessionEnd(payload, reason = "session_end") {
  const gatewayReady = await ensureGateway();
  if (!gatewayReady) return { flushed: false, reason: "gateway_unavailable" };
  const sessionKey = sessionKeyFromPayload(payload);
  const response = await httpPost("/session/end", {
    session_key: sessionKey,
    reason
  }, DEFAULT_SESSION_END_TIMEOUT_MS);
  return {
    flushed: !!response?.flushed,
    response
  };
}

export function compact(value, maxChars) {
  if (value === undefined || value === null || value === "") return "";
  let str;
  try {
    str = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    str = String(value);
  }
  return truncate(sanitizeMemoryText(str), maxChars);
}

export function redactText(value) {
  return redact(value);
}

export function sanitizeMemoryText(value) {
  return redact(stripInjectedMemoryTags(value));
}

export function stripInjectedMemoryTags(value) {
  let cleaned = String(value ?? "");
  for (const tag of INJECTED_MEMORY_TAGS) {
    cleaned = stripTagBlock(cleaned, tag);
    cleaned = stripHtmlEscapedTagBlock(cleaned, tag);
  }
  cleaned = cleaned.replace(
    /^\s*\{?\s*"hookSpecificOutput"\s*:\s*\{\s*"hookEventName"\s*:\s*"[^"]+"\s*,\s*"additionalContext"\s*:\s*""\s*\}\s*\}?\s*$/gm,
    "",
  );
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

export function toolOutputFromPayload(payload) {
  return (
    payload.tool_response ??
    payload.toolResponse ??
    payload.tool_output ??
    payload.tool_result ??
    payload.toolResult ??
    payload.output ??
    ""
  );
}

function renderToolValue(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function previewHeadTail(value, chars) {
  const str = String(value ?? "");
  if (str.length <= chars * 2 + 200) return str;
  return [
    str.slice(0, chars),
    `\n[...omitted ${str.length - chars * 2} chars; full redacted output is stored on disk...]\n`,
    str.slice(-chars)
  ].join("");
}

function truncate(value, maxChars) {
  const str = String(value ?? "");
  if (str.length <= maxChars) return str;
  return `${str.slice(0, maxChars)}\n[...truncated ${str.length - maxChars} chars]`;
}

function redact(value) {
  return String(value ?? "")
    .replace(REDACTION_PATTERNS.privateKey, "[REDACTED_PRIVATE_KEY]")
    .replace(REDACTION_PATTERNS.authorizationLine, "$1$2[REDACTED]")
    .replace(REDACTION_PATTERNS.bearer, "Bearer [REDACTED]")
    .replace(REDACTION_PATTERNS.gatewayToken, "$1[REDACTED_GATEWAY_TOKEN]")
    .replace(REDACTION_PATTERNS.openAiKey, "[REDACTED_API_KEY]")
    .replace(REDACTION_PATTERNS.githubPat, "[REDACTED_GITHUB_TOKEN]")
    .replace(REDACTION_PATTERNS.githubToken, "[REDACTED_GITHUB_TOKEN]")
    .replace(REDACTION_PATTERNS.slackToken, "[REDACTED_SLACK_TOKEN]")
    .replace(REDACTION_PATTERNS.awsAccessKey, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(REDACTION_PATTERNS.jsonDouble, "$1$2$1: \"[REDACTED]\"")
    .replace(REDACTION_PATTERNS.jsonSingle, "$1$2$1: '[REDACTED]'")
    .replace(REDACTION_PATTERNS.jsonBare, "$1$2$1: [REDACTED]")
    .replace(REDACTION_PATTERNS.envLike, "$1=[REDACTED]");
}

function stripTagBlock(value, tag) {
  const complete = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  const dangling = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "gi");
  return value.replace(complete, "").replace(dangling, "");
}

function stripHtmlEscapedTagBlock(value, tag) {
  const complete = new RegExp(`&lt;${tag}\\b[\\s\\S]*?&gt;[\\s\\S]*?&lt;/${tag}&gt;`, "gi");
  const dangling = new RegExp(`&lt;${tag}\\b[\\s\\S]*?&gt;[\\s\\S]*$`, "gi");
  return value.replace(complete, "").replace(dangling, "");
}

function sanitizeEventDetail(value) {
  if (typeof value === "string") return sanitizeMemoryText(value);
  if (Array.isArray(value)) return value.map(sanitizeEventDetail);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeEventDetail(item)]),
  );
}

function indentBlock(text, prefix) {
  return String(text).split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function numericEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function gatewayAuthHeaders() {
  const token = await readGatewayAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function readGatewayAuthToken() {
  const direct = process.env.TDAI_CODEX_GATEWAY_TOKEN || process.env.TDAI_GATEWAY_TOKEN;
  if (direct) return direct.trim();

  const tokenPath = configuredGatewayTokenPath();
  try {
    const token = (await fs.readFile(tokenPath, "utf-8")).trim();
    if (token) return token;
  } catch {
    // Missing token files are expected before the adapter autostarts Gateway.
  }
  return "";
}

export async function ensureGatewayAuthToken() {
  const tokenPath = configuredGatewayTokenPath();
  const existing = (process.env.TDAI_CODEX_GATEWAY_TOKEN || process.env.TDAI_GATEWAY_TOKEN || "").trim();
  if (existing) {
    await writePrivateFile(tokenPath, `${existing}\n`);
    return existing;
  }

  await ensurePrivateDir(path.dirname(tokenPath));

  try {
    const existingFileToken = (await fs.readFile(tokenPath, "utf-8")).trim();
    if (existingFileToken) return existingFileToken;
  } catch {
    // Missing token files are expected before first autostart.
  }

  const token = crypto.randomBytes(32).toString("base64url");
  let handle;
  try {
    handle = await fs.open(tokenPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(`${token}\n`);
    await handle.close();
    handle = null;
    await chmodPrivateFile(tokenPath);
    return token;
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Best effort cleanup after failed atomic create.
      }
    }
    if (err?.code !== "EEXIST") throw err;
    const racedToken = await readTokenWithRetry(tokenPath);
    if (racedToken) return racedToken;
    throw new Error(`Gateway token file already exists but is empty: ${tokenPath}`);
  }
}

async function readTokenWithRetry(tokenPath, attempts = 5, delayMs = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const token = (await fs.readFile(tokenPath, "utf-8")).trim();
    if (token) return token;
    await delay(delayMs);
  }
  return "";
}

export function configuredGatewayTokenPath() {
  return path.resolve(expandHome(process.env.TDAI_TOKEN_PATH || gatewayTokenPath()));
}

function gatewayTokenPath() {
  return path.join(tdaiDataDir(), "codex-adapter", "gateway-token");
}

async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await fs.chmod(dir, PRIVATE_DIR_MODE);
  } catch {
    // Best effort: chmod can fail on some mounted filesystems.
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
    // Best effort: chmod can fail on some mounted filesystems.
  }
}

function escapeText(value) {
  return String(value).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hydrateLoginShellEnv(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length === 0) return;
  try {
    // Values are serialized one variable per line; multiline env values are intentionally unsupported here.
    const script = missing.map((name) => `printf '%s=%s\\n' ${shellQuote(name)} "${"$"}${name}"`).join("; ");
    const output = await captureCommand("zsh", ["-lc", script], 1500);
    for (const line of output.split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const name = line.slice(0, idx);
      const value = line.slice(idx + 1);
      if (value && !env[name]) env[name] = value;
    }
  } catch (err) {
    debug(`Unable to hydrate login-shell env: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function captureCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function debug(message) {
  const line = `[${new Date().toISOString()}] ${truncate(redact(String(message)), 2000)}\n`;
  try {
    const file = hookLogPath();
    fsSync.mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
    fsSync.appendFileSync(file, line, { mode: PRIVATE_FILE_MODE });
    try {
      fsSync.chmodSync(file, PRIVATE_FILE_MODE);
    } catch {
      // Best effort: Windows and some filesystems do not expose POSIX modes.
    }
  } catch {
    // Hook diagnostics must never make memory capture/recall fail.
  }
  if (process.env.TDAI_CODEX_DEBUG === "true") {
    process.stderr.write(`[tdai-codex] ${line}`);
  }
}
