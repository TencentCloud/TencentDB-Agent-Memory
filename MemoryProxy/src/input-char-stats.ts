/**
 * Per-request input composition, in characters.
 *
 * Measured on the upstream body right before the preparation stage rewrites it
 * (after every host-side injection), so it shows what the request carried
 * before compression. The numbers ride along in `extensionStats` and land in
 * the same `usage_logs` row as the upstream token usage.
 *
 * Rules shared by every protocol:
 *   - Images never count as characters. Image blocks (`image`, `image_url`,
 *     `input_image`) and `data:image/...;base64,` URIs embedded in text only
 *     bump `inputImageCount`.
 *   - Other binary payloads (base64 documents / files) are not counted either.
 *   - Encrypted or opaque content (thinking signatures, redacted thinking,
 *     Responses `encrypted_content`) goes to `inputOtherChars`.
 *   - Anything the classifier does not recognize goes to `inputOtherChars`.
 */

import type { PreparedProtocol } from "./request-prepare-adapter.js";

export interface InputCharStats {
  inputSystemChars: number;
  inputUserChars: number;
  inputToolSchemaChars: number;
  inputReasoningChars: number;
  inputToolCallChars: number;
  inputToolResultChars: number;
  inputAssistantTextChars: number;
  inputOtherChars: number;
  inputImageCount: number;
}

type CharKey = Exclude<keyof InputCharStats, "inputImageCount">;

export function emptyInputCharStats(): InputCharStats {
  return {
    inputSystemChars: 0,
    inputUserChars: 0,
    inputToolSchemaChars: 0,
    inputReasoningChars: 0,
    inputToolCallChars: 0,
    inputToolResultChars: 0,
    inputAssistantTextChars: 0,
    inputOtherChars: 0,
    inputImageCount: 0,
  };
}

/** A base64 data URI with its payload (base64 alphabet only, so trailing prose is kept). */
const DATA_URI_RE = /data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,[A-Za-z0-9+/=]*/gi;
const IMAGE_BLOCK_TYPES = new Set(["image", "image_url", "input_image"]);
const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);
/** Bounds the recursive walk over unknown payloads. */
const MAX_DEPTH = 32;

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Rec : null;
}

class Collector {
  readonly stats = emptyInputCharStats();

  /** Add a string's characters, dropping (and counting) embedded base64 payloads. */
  text(key: CharKey, s: unknown): void {
    if (typeof s !== "string" || s.length === 0) return;
    if (!s.includes(";base64,")) {
      this.stats[key] += s.length;
      return;
    }
    let removed = 0;
    for (const m of s.matchAll(DATA_URI_RE)) {
      removed += m[0].length;
      if (m[1].toLowerCase().startsWith("image/")) this.stats.inputImageCount++;
    }
    this.stats[key] += Math.max(0, s.length - removed);
  }

  /** Serialized length of a structured value (tool schemas, tool-call input objects). */
  json(key: CharKey, value: unknown): void {
    if (value === undefined || value === null) return;
    if (typeof value === "string") {
      this.text(key, value);
      return;
    }
    // An empty container carries no content; counting its braces would add a
    // constant offset to every request that declares no tools.
    if (Array.isArray(value) && value.length === 0) return;
    if (asRec(value) && Object.keys(value as Rec).length === 0) return;
    try {
      this.text(key, JSON.stringify(value));
    } catch {
      this.strings(key, value);
    }
  }

  /** Every string reachable from `value`, skipping base64 sources and counting images. */
  strings(key: CharKey, value: unknown, depth = 0): void {
    if (depth > MAX_DEPTH) return;
    if (typeof value === "string") {
      this.text(key, value);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) this.strings(key, child, depth + 1);
      return;
    }
    const obj = asRec(value);
    if (!obj) return;
    if (typeof obj.type === "string" && IMAGE_BLOCK_TYPES.has(obj.type)) {
      this.stats.inputImageCount++;
      return;
    }
    const base64Source = obj.type === "base64";
    for (const [k, child] of Object.entries(obj)) {
      if (base64Source && k === "data") continue;
      this.strings(key, child, depth + 1);
    }
  }

  /**
   * Message content: a string, or an array of parts. Text parts go to `key`,
   * images are counted, everything else is "other".
   */
  content(key: CharKey, content: unknown): void {
    if (typeof content === "string") {
      this.text(key, content);
      return;
    }
    if (!Array.isArray(content)) {
      if (content !== undefined && content !== null) this.strings("inputOtherChars", content);
      return;
    }
    for (const part of content) {
      if (typeof part === "string") {
        this.text(key, part);
        continue;
      }
      const p = asRec(part);
      if (!p) continue;
      if (typeof p.type === "string" && IMAGE_BLOCK_TYPES.has(p.type)) {
        this.stats.inputImageCount++;
      } else if (typeof p.type === "string" && TEXT_PART_TYPES.has(p.type)) {
        this.text(key, p.text);
      } else if (p.type === "refusal") {
        this.text(key, p.refusal);
      } else {
        this.strings("inputOtherChars", p);
      }
    }
  }
}

// ─── Anthropic Messages ─────────────────────────────────────────────────────

function collectAnthropic(c: Collector, body: Rec, messages: unknown[]): void {
  c.content("inputSystemChars", body.system);
  for (const raw of messages) {
    const m = asRec(raw);
    if (!m) continue;
    if (m.role === "assistant") {
      collectAnthropicAssistant(c, m.content);
    } else if (m.role === "user") {
      collectAnthropicUser(c, m.content);
    } else {
      c.strings("inputOtherChars", m.content);
    }
  }
}

function collectAnthropicUser(c: Collector, content: unknown): void {
  if (!Array.isArray(content)) {
    c.content("inputUserChars", content);
    return;
  }
  for (const raw of content) {
    const b = asRec(raw);
    if (!b) {
      c.text("inputUserChars", raw);
      continue;
    }
    if (b.type === "tool_result") {
      c.content("inputToolResultChars", b.content);
    } else {
      c.content("inputUserChars", [b]);
    }
  }
}

function collectAnthropicAssistant(c: Collector, content: unknown): void {
  if (!Array.isArray(content)) {
    c.content("inputAssistantTextChars", content);
    return;
  }
  for (const raw of content) {
    const b = asRec(raw);
    if (!b) {
      c.text("inputAssistantTextChars", raw);
      continue;
    }
    switch (b.type) {
      case "text":
        c.text("inputAssistantTextChars", b.text);
        break;
      case "thinking":
        c.text("inputReasoningChars", b.thinking);
        c.text("inputOtherChars", b.signature);
        break;
      case "redacted_thinking":
        c.text("inputOtherChars", b.data);
        break;
      case "tool_use":
      case "server_tool_use":
        c.text("inputToolCallChars", b.name);
        c.json("inputToolCallChars", b.input);
        break;
      default:
        c.content("inputAssistantTextChars", [b]);
    }
  }
}

// ─── OpenAI Chat Completions ────────────────────────────────────────────────

function collectOpenAIChat(c: Collector, messages: unknown[]): void {
  for (const raw of messages) {
    const m = asRec(raw);
    if (!m) continue;
    switch (m.role) {
      case "system":
      case "developer":
        c.content("inputSystemChars", m.content);
        break;
      case "user":
        c.content("inputUserChars", m.content);
        break;
      case "tool":
      case "function":
        c.content("inputToolResultChars", m.content);
        break;
      case "assistant":
        c.content("inputAssistantTextChars", m.content);
        c.text("inputReasoningChars", m.reasoning_content);
        c.text("inputReasoningChars", m.reasoning);
        collectOpenAIToolCalls(c, m.tool_calls);
        if (asRec(m.function_call)) collectOpenAIToolCalls(c, [{ function: m.function_call }]);
        break;
      default:
        c.strings("inputOtherChars", m.content);
    }
  }
}

function collectOpenAIToolCalls(c: Collector, toolCalls: unknown): void {
  if (!Array.isArray(toolCalls)) return;
  for (const raw of toolCalls) {
    const tc = asRec(raw);
    const fn = asRec(tc?.function);
    if (fn) {
      c.text("inputToolCallChars", fn.name);
      c.json("inputToolCallChars", fn.arguments);
    } else if (tc) {
      c.strings("inputToolCallChars", tc);
    }
  }
}

// ─── OpenAI Responses ───────────────────────────────────────────────────────

const RESPONSES_TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "local_shell_call_output",
  "computer_call_output",
]);

function collectResponses(c: Collector, body: Rec, items: unknown[]): void {
  c.content("inputSystemChars", body.instructions);
  for (const raw of items) {
    const it = asRec(raw);
    if (!it) {
      c.text("inputUserChars", raw);
      continue;
    }
    const type = typeof it.type === "string" ? it.type : "message";
    if (type === "message") {
      collectResponsesMessage(c, it);
    } else if (type === "reasoning") {
      for (const part of Array.isArray(it.summary) ? it.summary : []) {
        c.text("inputReasoningChars", asRec(part)?.text);
      }
      for (const part of Array.isArray(it.content) ? it.content : []) {
        c.text("inputReasoningChars", asRec(part)?.text);
      }
      c.text("inputOtherChars", it.encrypted_content);
    } else if (type === "function_call") {
      c.text("inputToolCallChars", it.name);
      c.json("inputToolCallChars", it.arguments);
    } else if (type === "custom_tool_call") {
      c.text("inputToolCallChars", it.name);
      c.json("inputToolCallChars", it.input);
    } else if (RESPONSES_TOOL_OUTPUT_TYPES.has(type)) {
      c.content("inputToolResultChars", it.output);
    } else {
      c.strings("inputOtherChars", it);
    }
  }
}

function collectResponsesMessage(c: Collector, it: Rec): void {
  switch (it.role) {
    case "system":
    case "developer":
      c.content("inputSystemChars", it.content);
      break;
    case "user":
      c.content("inputUserChars", it.content);
      break;
    case "assistant":
      c.content("inputAssistantTextChars", it.content);
      break;
    default:
      c.strings("inputOtherChars", it.content);
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Character breakdown of one upstream request. Pure and never throws; an
 * unexpected shape degrades to whatever could be classified.
 *
 * @param messages - `body.messages` (Anthropic / Chat) or `body.input` (Responses).
 */
export function measureInputChars(
  protocol: PreparedProtocol,
  body: Record<string, unknown>,
  messages: unknown[],
): InputCharStats {
  const c = new Collector();
  try {
    c.json("inputToolSchemaChars", body.tools);
    if (protocol === "openai") c.json("inputToolSchemaChars", body.functions);
    if (protocol === "anthropic") collectAnthropic(c, body, messages);
    else if (protocol === "responses") collectResponses(c, body, messages);
    else collectOpenAIChat(c, messages);
  } catch {
    // Partial numbers are still better than none; never block the request.
  }
  return c.stats;
}
