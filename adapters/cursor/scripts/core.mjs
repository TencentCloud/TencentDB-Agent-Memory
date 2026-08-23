import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_URL = "http://127.0.0.1:8420";
let gbkEncodeMap;

function getGbkEncodeMap() {
  if (gbkEncodeMap) return gbkEncodeMap;
  const decoder = new TextDecoder("gbk", { fatal: true });
  const map = new Map();
  for (let byte = 0; byte < 0x80; byte++) map.set(String.fromCharCode(byte), [byte]);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      try {
        const char = decoder.decode(Uint8Array.of(lead, trail));
        if (char.length === 1 && char !== "�" && !map.has(char)) map.set(char, [lead, trail]);
      } catch { /* invalid GBK pair */ }
    }
  }
  gbkEncodeMap = map;
  return map;
}

/** Recover UTF-8 text that Cursor's Windows hook runner decoded as GBK. */
export function recoverWindowsHookText(value) {
  if (typeof value !== "string" || !/[^\x00-\x7f]/.test(value)) return value;
  const map = getGbkEncodeMap();
  const bytes = [];
  for (const char of value) {
    const encoded = map.get(char);
    if (!encoded) return value;
    bytes.push(...encoded);
  }
  const recovered = new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
  const replacements = recovered.match(/�/g)?.length ?? 0;
  return replacements <= Math.max(1, Math.floor(value.length / 20)) ? recovered : value;
}

export function recoverWindowsHookInput(value) {
  if (typeof value === "string") return recoverWindowsHookText(value);
  if (Array.isArray(value)) return value.map(recoverWindowsHookInput);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, recoverWindowsHookInput(item)]));
  }
  return value;
}

function decodeSalvagedJsonString(value) {
  return value.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (match, escape) => {
    if (escape[0] === "u") return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" })[escape] ?? match;
  });
}

/** Parse hook stdin even when Cursor's Windows runner turns UTF-8 punctuation into
 * characters that prematurely terminate a JSON string. Known top-level fields have
 * stable ASCII neighbours, so they can still be recovered without guessing content. */
export function parseWindowsHookInput(raw = "") {
  const text = (raw || "{}").replace(/^\uFEFF/, "");
  try { return recoverWindowsHookInput(JSON.parse(text)); }
  catch (parseError) {
    const value = {};
    const scalarFields = ["conversation_id", "generation_id", "session_id", "hook_event_name", "user_email", "transcript_path"];
    for (const field of scalarFields) {
      const match = text.match(new RegExp(`"${field}"\\s*:\\s*"([^"\\r\\n]*)"`));
      if (match) value[field] = decodeSalvagedJsonString(match[1]);
    }
    const boundedFields = [
      ["prompt", "attachments"],
      ["text", "input_tokens"],
    ];
    for (const [field, nextField] of boundedFields) {
      const startMarker = `"${field}":"`;
      const start = text.indexOf(startMarker);
      const end = start < 0 ? -1 : text.indexOf(`,"${nextField}":`, start + startMarker.length);
      if (start >= 0 && end >= 0) {
        const content = text.slice(start + startMarker.length, end).replace(/"$/, "");
        value[field] = decodeSalvagedJsonString(content);
      }
    }
    if (!value.hook_event_name || !value.conversation_id) throw parseError;
    return recoverWindowsHookInput(value);
  }
}

function transcriptText(message) {
  const parts = message?.message?.content;
  if (!Array.isArray(parts)) return "";
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

/** Prefer Cursor's UTF-8 transcript over lossy Windows hook stdin. */
export async function enrichFromTranscript(input) {
  // Cursor writes the current user entry after beforeSubmitPrompt, so reading the
  // transcript there can accidentally select the preceding turn. At response time
  // both sides of the current turn are present and safe to use.
  if (!input?.transcript_path || input.hook_event_name !== "afterAgentResponse") return input;
  try {
    const lines = (await readFile(input.transcript_path, "utf8")).split(/\r?\n/).filter(Boolean);
    const found = {};
    for (let index = lines.length - 1; index >= 0 && (!found.user || !found.assistant); index--) {
      let entry;
      try { entry = JSON.parse(lines[index]); } catch { continue; }
      if (!["user", "assistant"].includes(entry?.role) || found[entry.role]) continue;
      let text = transcriptText(entry);
      if (!text) continue;
      if (entry.role === "user") text = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)?.[1] || text;
      found[entry.role] = text;
    }
    return { ...input, ...(found.user ? { prompt: found.user } : {}), ...(found.assistant ? { text: found.assistant } : {}) };
  } catch { /* transcript can be absent or briefly unavailable; keep hook data */ }
  return input;
}

export function config(env = process.env) {
  const configured = (value, fallback = "") => {
    const text = (value || "").trim();
    return /^\$\{[^}]+\}$/.test(text) ? fallback : (text || fallback);
  };
  const agentId = configured(env.TDAI_CURSOR_AGENT_ID, "cursor");
  return {
    gatewayUrl: configured(env.TDAI_GATEWAY_URL, DEFAULT_URL).replace(/\/+$/, ""),
    apiKey: configured(env.TDAI_GATEWAY_API_KEY),
    agentId,
    sessionKey: `agent:${agentId}:cursor`,
    stateDir: env.TDAI_CURSOR_STATE_DIR || path.join(os.homedir(), ".tencentdb-agent-memory", "cursor"),
  };
}

export async function gatewayRequest(route, body, options = {}) {
  const cfg = options.config || config();
  const headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 8000);
  try {
    const response = await (options.fetch || fetch)(`${cfg.gatewayUrl}${route}`, {
      method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Gateway ${response.status}: ${text.slice(0, 300)}`);
    const payload = text ? JSON.parse(text) : {};
    if (payload && typeof payload === "object" && (payload.error || payload.code)) {
      throw new Error(payload.error || payload.message || `Gateway error ${payload.code}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function stateFile(cfg) { return path.join(cfg.stateDir, "state.json"); }
function emptyState() { return { version: 1, conversations: {} }; }

export function pruneState(state, now = Date.now(), pendingTtlMs = 7 * 86400000, capturedTtlMs = 30 * 86400000) {
  for (const [conversationId, conv] of Object.entries(state.conversations || {})) {
    for (const [generationId, turn] of Object.entries(conv.pending || {})) {
      if (!turn?.createdAt || now - turn.createdAt > pendingTtlMs) delete conv.pending[generationId];
    }
    for (const [generationId, turn] of Object.entries(conv.captured || {})) {
      if (!turn?.capturedAt || now - turn.capturedAt > capturedTtlMs) delete conv.captured[generationId];
    }
    if (!Object.keys(conv.pending || {}).length && !Object.keys(conv.captured || {}).length) delete state.conversations[conversationId];
  }
  return state;
}

export async function readState(cfg = config()) {
  try { return JSON.parse(await readFile(stateFile(cfg), "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return emptyState(); throw error; }
}

export async function writeState(state, cfg = config()) {
  await mkdir(cfg.stateDir, { recursive: true });
  const target = stateFile(cfg);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

function conversation(state, id) {
  state.conversations[id] ||= { pending: {}, captured: {} };
  return state.conversations[id];
}

export async function rememberPrompt(input, cfg = config()) {
  const state = pruneState(await readState(cfg));
  const conv = conversation(state, input.conversation_id);
  conv.pending[input.generation_id] = { prompt: input.prompt, createdAt: Date.now() };
  await writeState(state, cfg);
}

export async function captureResponse(input, cfg = config(), request = gatewayRequest) {
  const state = pruneState(await readState(cfg));
  const conv = conversation(state, input.conversation_id);
  const generationId = input.generation_id;
  if (conv.captured[generationId]) return { duplicate: true };
  const pending = conv.pending[generationId];
  if (!pending?.prompt || !input.text) return { skipped: true, reason: "unpaired turn" };
  const prompt = input.prompt || pending.prompt;
  const fingerprint = createHash("sha256").update(`${input.conversation_id}\0${generationId}\0${prompt}\0${input.text}`).digest("hex");
  await request("/capture", {
    user_content: prompt,
    assistant_content: input.text,
    session_key: cfg.sessionKey,
    session_id: input.conversation_id,
    messages: [
      { role: "user", content: prompt, generation_id: generationId },
      { role: "assistant", content: input.text, generation_id: generationId },
    ],
  }, { config: cfg });
  delete conv.pending[generationId];
  conv.captured[generationId] = { fingerprint, capturedAt: Date.now() };
  await writeState(state, cfg);
  return { captured: true, fingerprint };
}

export async function sessionRecall(input, cfg = config(), request = gatewayRequest) {
  return request("/recall", {
    query: "Current project context, durable user preferences, prior decisions, and unfinished work relevant to a new Cursor session",
    session_key: cfg.sessionKey,
    user_id: input.user_email || undefined,
  }, { config: cfg });
}
