/**
 * OpenAI Chat Completions ↔ Anthropic Messages 双向兼容层（TRACK 05A）。
 *
 * 场景：
 *  - Claude Code（Anthropic 客户端）→ OpenAI 风格上游：anthropicToChat + createChatSseToAnthropicSse
 *  - WorkBuddy（Chat 客户端）→ Anthropic 风格上游：chatToAnthropic + createAnthropicSseToChatSse
 *
 * 覆盖：文本、图片（base64/url）、工具调用、流式 SSE、非流式 JSON、usage 字段映射。
 * 独立性约束：不 import 任何 client handler / adapter，纯函数 + TransformStream，便于单测。
 */

import { createSseFrameParser } from "./sse.js";
import { recordConversion, recordStream, recordCacheUsage, recordDrop } from "./protocol-stats.js";

// ── 工具函数 ─────────────────────────────────────────────────────────────────

function randomId(): string {
  const hex = Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
  return hex;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function anthropicEvent(name: string, obj: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const r = asRecord(b);
      if (r?.type === "text" && typeof r.text === "string") return r.text;
      return "";
    })
    .join("\n");
}

/** Anthropic tool_result.content → OpenAI tool 消息 content（支持文本 + 图片混合）。 */
function anthropicToolResultToChatContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content ?? "";
  const parts: unknown[] = [];
  for (const b of content) {
    const r = asRecord(b);
    if (!r) continue;
    if (r.type === "text" && typeof r.text === "string") parts.push({ type: "text", text: r.text });
    else if (r.type === "image") {
      const url = anthropicImageToUrl(r.source);
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
  }
  if (parts.length === 1 && (parts[0] as Record<string, unknown>).type === "text") {
    return (parts[0] as { text: string }).text;
  }
  return parts.length > 0 ? parts : "";
}

/** Anthropic image source → OpenAI image_url（base64 转 data URL，url 直用）。 */
function anthropicImageToUrl(source: unknown): string {
  const s = asRecord(source);
  if (!s) return "";
  if (s.type === "url" && typeof s.url === "string") return s.url;
  if (s.type === "base64" && typeof s.data === "string") {
    const media = typeof s.media_type === "string" ? s.media_type : "image/png";
    return `data:${media};base64,${s.data}`;
  }
  return "";
}

/** Anthropic system（string 或 blocks 数组）→ 纯文本。 */
function anthropicSystemToText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return blockText(system);
  return "";
}

/** Chat messages[].content（string 或 parts）→ Anthropic 文本。 */
function chatContentToAnthropic(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content ?? "";
  const blocks: unknown[] = [];
  for (const p of content) {
    const r = asRecord(p);
    if (!r) continue;
    if (r.type === "text" && typeof r.text === "string") blocks.push({ type: "text", text: r.text });
    else if (r.type === "image_url") {
      const iu = asRecord(r.image_url);
      const url = typeof r.image_url === "string" ? r.image_url : iu?.url;
      if (typeof url === "string") {
        blocks.push({
          type: "image",
          source: url.startsWith("data:")
            ? (() => {
                const m = url.match(/^data:([^;,]+);base64,(.*)$/s);
                return m
                  ? { type: "base64", media_type: m[1], data: m[2] }
                  : { type: "base64", media_type: "image/png", data: url.split(",").slice(1).join(",") };
              })()
            : { type: "url", url },
        });
      }
    }
  }
  return blocks.length > 0 ? blocks : "";
}

// ── 请求体：Anthropic → Chat ────────────────────────────────────────────────

export function anthropicToChat(
  body: Record<string, unknown>,
  opts: { preserveSignature?: boolean; onDropped?: (param: string) => void } = {},
): Record<string, unknown> {
  const _t0 = performance.now();
  const messages: Array<Record<string, unknown>> = [];
  const sysText = anthropicSystemToText(body.system);
  if (sysText) messages.push({ role: "system", content: sysText });

  for (const raw of Array.isArray(body.messages) ? (body.messages as unknown[]) : []) {
    const m = asRecord(raw);
    if (!m) continue;
    const role = m.role;
    const content = m.content;
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === "user") {
      const parts: unknown[] = [];
      for (const b of content) {
        const blk = asRecord(b);
        if (!blk) continue;
        if (blk.type === "text" && typeof blk.text === "string") {
          parts.push({ type: "text", text: blk.text });
        } else if (blk.type === "image") {
          const url = anthropicImageToUrl(blk.source);
          if (url) parts.push({ type: "image_url", image_url: { url } });
        } else if (blk.type === "tool_result") {
          if (parts.length > 0) {
            messages.push({ role: "user", content: parts });
            parts.length = 0;
          }
          messages.push({
            role: "tool",
            tool_call_id: typeof blk.tool_use_id === "string" ? blk.tool_use_id : "",
            content: anthropicToolResultToChatContent(blk.content),
          });
        }
      }
      if (parts.length > 0) messages.push({ role: "user", content: parts });
    } else if (role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      let reasoning = "";
      let reasoningSignature = "";
      for (const b of content) {
        const blk = asRecord(b);
        if (!blk) continue;
        if (blk.type === "text" && typeof blk.text === "string") textParts.push(blk.text);
        else if (blk.type === "thinking" && typeof blk.thinking === "string") {
          reasoning += blk.thinking;
          if (typeof blk.signature === "string") reasoningSignature = blk.signature;
        }
        else if (blk.type === "tool_use") {
          toolCalls.push({
            id: typeof blk.id === "string" ? blk.id : `call_${randomId()}`,
            type: "function",
            function: {
              name: blk.name ?? "",
              arguments:
                typeof blk.input === "string"
                  ? blk.input
                  : JSON.stringify(blk.input ?? {}),
            },
          });
        }
      }
      const msg: Record<string, unknown> = {
        role: "assistant",
        content: textParts.join("\n") || null,
      };
      if (reasoning) msg.reasoning_content = reasoning;
      if (opts.preserveSignature && reasoningSignature) {
        msg.anthropic_reasoning_signature = reasoningSignature;
      }
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      messages.push(msg);
    }
  }

  const out: Record<string, unknown> = { model: body.model, messages };
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  const md = asRecord(body.metadata);
  if (md && typeof md.user_id === "string") out.user = md.user_id;
  // 丢参始终计入 /metrics（recordDrop），不依赖调用方接线 onDropped；
  // metadata 键名可能来自客户端，按聚合名 “metadata” 计数避免 label 基数失控。
  const drop = (param: string): void => {
    opts.onDropped?.(param);
    recordDrop("anthropic_to_chat", param);
  };
  if (body.top_k !== undefined) drop("top_k");
  if (body.thinking !== undefined) drop("thinking");
  if (md) {
    for (const k of Object.keys(md)) {
      if (k !== "user_id") {
        opts.onDropped?.(`metadata.${k}`);
        recordDrop("anthropic_to_chat", "metadata");
      }
    }
  }
  if (body.stream === true) out.stream = true;
  const tools = anthropicToolsToChat(body.tools);
  if (tools) out.tools = tools;
  if (Array.isArray(body.stop_sequences)) out.stop = body.stop_sequences;
  const tc = anthropicToolChoiceToChat(body.tool_choice);
  if (tc !== undefined) out.tool_choice = tc;
  const tcObj = asRecord(body.tool_choice);
  if (tcObj && tcObj.disable_parallel_tool_use === true) out.parallel_tool_calls = false;
  recordConversion("anthropic_to_chat", performance.now() - _t0);
  return out;
}

function anthropicToolsToChat(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out = tools
    .map((t) => {
      const r = asRecord(t);
      if (!r || typeof r.name !== "string") return null;
      return {
        type: "function",
        function: {
          name: r.name,
          description: typeof r.description === "string" ? r.description : "",
          parameters: r.input_schema ?? { type: "object", properties: {} },
        },
      };
    })
    .filter(Boolean) as unknown[];
  return out.length > 0 ? out : undefined;
}

/**
 * Anthropic tool_choice → OpenAI chat tool_choice：
 *   auto → auto；any → required；{type:"tool", name} → {type:"function", function:{name}}；
 *   其它（none/未知）→ undefined（不输出，交给上游默认行为）。
 */
function anthropicToolChoiceToChat(tc: unknown): unknown {
  if (tc === "auto") return "auto";
  if (tc === "any" || asRecord(tc)?.type === "any") return "required";
  const r = asRecord(tc);
  if (r && r.type === "tool" && typeof r.name === "string") {
    return { type: "function", function: { name: r.name } };
  }
  return undefined;
}

/**
 * OpenAI chat tool_choice → Anthropic tool_choice：
 *   auto → auto；required → any；{type:"function", function:{name}} → {type:"tool", name}；
 *   none / 未知 → undefined（Anthropic 无 none 语义，省略即“按需”）。
 */
function chatToolChoiceToAnthropic(tc: unknown): unknown {
  if (tc === "auto") return "auto";
  if (tc === "required") return "any";
  const r = asRecord(tc);
  if (r && r.type === "function") {
    const fn = asRecord(r.function);
    if (fn && typeof fn.name === "string") return { type: "tool", name: fn.name };
  }
  return undefined;
}

// ── 请求体：Chat → Anthropic ────────────────────────────────────────────────

export function chatToAnthropic(
  body: Record<string, unknown>,
  opts: {
    thinking?: "map" | "strip";
    preserveSignature?: boolean;
    onDropped?: (param: string) => void;
  } = {},
): Record<string, unknown> {
  const _t0 = performance.now();
  const messages: Array<Record<string, unknown>> = [];
  let system = "";
  const mapThinking = opts.thinking === "map";

  for (const raw of Array.isArray(body.messages) ? (body.messages as unknown[]) : []) {
    const m = asRecord(raw);
    if (!m) continue;
    const role = m.role;
    if (role === "system") {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }
    if (role === "developer") {
      // OpenAI 新版 developer 角色语义等同 system（系统级指令），不能落成 user。
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }
    if (role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: typeof m.tool_call_id === "string" ? m.tool_call_id : "",
            content: chatContentToAnthropic(m.content) ?? "",
          },
        ],
      });
      continue;
    }
    if (role === "assistant" && asRecord(m.function_call)) {
      const fc = asRecord(m.function_call);
      const blocks: unknown[] = [];
      if (typeof m.content === "string" && m.content) blocks.push({ type: "text", text: m.content });
      let input: unknown = {};
      if (fc && typeof fc.arguments === "string") {
        try {
          input = JSON.parse(fc.arguments);
        } catch {
          input = fc.arguments;
        }
      } else if (fc) {
        input = fc.arguments ?? {};
      }
      blocks.push({
        type: "tool_use",
        id: `toolu_${randomId()}`,
        name: typeof fc?.name === "string" ? fc.name : "",
        input,
      });
      messages.push({ role: "assistant", content: blocks });
      continue;
    }
    if (role === "assistant" && Array.isArray(m.tool_calls)) {
      const blocks: unknown[] = [];
      if (mapThinking && typeof m.reasoning_content === "string" && m.reasoning_content) {
        blocks.push({
          type: "thinking",
          thinking: m.reasoning_content,
          ...(opts.preserveSignature && typeof m.anthropic_reasoning_signature === "string"
            ? { signature: m.anthropic_reasoning_signature }
            : {}),
        });
      }
      if (typeof m.content === "string" && m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls as unknown[]) {
        const t = asRecord(tc);
        if (!t) continue;
        const fn = asRecord(t.function);
        let input: unknown = {};
        if (fn && typeof fn.arguments === "string") {
          try {
            input = JSON.parse(fn.arguments);
          } catch {
            input = fn.arguments;
          }
        }
        blocks.push({
          type: "tool_use",
          id: typeof t.id === "string" ? t.id : `toolu_${randomId()}`,
          name: fn?.name ?? "",
          input,
        });
      }
      messages.push({ role: "assistant", content: blocks });
      continue;
    }
    if (
      role === "assistant" &&
      typeof m.reasoning_content === "string" &&
      m.reasoning_content
    ) {
      const blocks: unknown[] = [];
      if (mapThinking) {
        blocks.push({
          type: "thinking",
          thinking: m.reasoning_content,
          ...(opts.preserveSignature && typeof m.anthropic_reasoning_signature === "string"
            ? { signature: m.anthropic_reasoning_signature }
            : {}),
        });
      }
      const converted = chatContentToAnthropic(m.content);
      if (typeof converted === "string" && converted) blocks.push({ type: "text", text: converted });
      else if (Array.isArray(converted)) blocks.push(...converted);
      messages.push({ role: "assistant", content: blocks.length > 0 ? blocks : "" });
      continue;
    }
    messages.push({
      role: role === "assistant" ? "assistant" : "user",
      content: chatContentToAnthropic(m.content),
    });
  }

  const out: Record<string, unknown> = {
    model: body.model,
    messages,
    max_tokens:
      typeof body.max_tokens === "number"
        ? body.max_tokens
        : typeof body.max_completion_tokens === "number"
          ? body.max_completion_tokens
          : 4096,
  };
  if (system) out.system = system;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.user === "string") out.metadata = { user_id: body.user };
  if (body.stream === true) out.stream = true;
  // OpenAI tool_choice:"none" 在 Anthropic 无对位值：保留 tools 再省略 tool_choice 会
  // 变成 auto（仍可能调用工具），语义反转。等价近似 = 不携带任何 tools ——
  // Anthropic 没有工具列表就不会调用工具。
  const noToolCalls = body.tool_choice === "none";
  const tools = noToolCalls ? undefined : chatToolsToAnthropic(body.tools);
  if (tools) out.tools = tools;
  else if (!noToolCalls && Array.isArray(body.functions)) {
    const fns = (body.functions as unknown[])
      .map((f) => {
        const r = asRecord(f);
        if (!r || typeof r.name !== "string") return null;
        return {
          name: r.name,
          description: typeof r.description === "string" ? r.description : "",
          input_schema: r.parameters ?? { type: "object", properties: {} },
        };
      })
      .filter(Boolean) as unknown[];
    if (fns.length > 0) out.tools = fns;
  }
  if (Array.isArray(body.stop)) out.stop_sequences = body.stop;
  else if (typeof body.stop === "string") out.stop_sequences = [body.stop];
  const drop = (param: string): void => {
    opts.onDropped?.(param);
    recordDrop("chat_to_anthropic", param);
  };
  for (const k of [
    "logprobs",
    "top_logprobs",
    "logit_bias",
    "presence_penalty",
    "frequency_penalty",
    "seed",
    "n",
    "response_format",
    "stream_options",
  ]) {
    if (body[k] !== undefined) drop(k);
  }
  if (!noToolCalls) {
    let tc = chatToolChoiceToAnthropic(body.tool_choice);
    if (body.parallel_tool_calls === false) {
      if (tc === undefined || tc === "auto") {
        tc = { type: "auto", disable_parallel_tool_use: true };
      } else if (asRecord(tc)) {
        (tc as Record<string, unknown>).disable_parallel_tool_use = true;
      }
    }
    if (tc !== undefined) out.tool_choice = tc;
  }
  recordConversion("chat_to_anthropic", performance.now() - _t0);
  return out;
}

function chatToolsToAnthropic(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out = tools
    .map((t) => {
      const r = asRecord(t);
      const fn = asRecord(r?.function);
      if (!r || !fn || typeof fn.name !== "string") return null;
      return {
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : "",
        input_schema: fn.parameters ?? { type: "object", properties: {} },
      };
    })
    .filter(Boolean) as unknown[];
  return out.length > 0 ? out : undefined;
}

// ── 非流式 JSON 响应 ────────────────────────────────────────────────────────

/** 上游 chat JSON → 客户端 anthropic JSON。 */
export function chatJsonToAnthropicJson(
  json: Record<string, unknown>,
  opts: { thinking?: "map" | "strip"; preserveSignature?: boolean } = {},
): Record<string, unknown> {
  const _t0 = performance.now();
  const choice = asRecord((json.choices as unknown[] | undefined)?.[0]);
  const msg = asRecord(choice?.message);
  const content: unknown[] = [];
  const reasoning =
    opts.thinking === "map" && typeof msg?.reasoning_content === "string"
      ? msg.reasoning_content
      : "";
  if (reasoning) {
    content.push({
      type: "thinking",
      thinking: reasoning,
      ...(opts.preserveSignature && typeof msg?.anthropic_reasoning_signature === "string"
        ? { signature: msg.anthropic_reasoning_signature }
        : {}),
    });
  }
  const text = typeof msg?.content === "string" ? msg.content : "";
  if (text) content.push({ type: "text", text });
  const fc = asRecord(msg?.function_call);
  if (fc && typeof fc.name === "string") {
    let input: unknown = {};
    if (typeof fc.arguments === "string") {
      try {
        input = JSON.parse(fc.arguments);
      } catch {
        input = fc.arguments;
      }
    }
    content.push({ type: "tool_use", id: `toolu_${randomId()}`, name: fc.name, input });
  }
  if (Array.isArray(msg?.tool_calls)) {
    for (const tc of msg.tool_calls as unknown[]) {
      const t = asRecord(tc);
      const fn = asRecord(t?.function);
      let input: unknown = {};
      if (fn && typeof fn.arguments === "string") {
        try {
          input = JSON.parse(fn.arguments);
        } catch {
          input = fn.arguments;
        }
      }
      content.push({
        type: "tool_use",
        id: typeof t?.id === "string" ? t.id : `toolu_${randomId()}`,
        name: fn?.name ?? "",
        input,
      });
    }
  }
  const usage = asRecord(json.usage);
  recordCacheUsage({
    cached:
      typeof usage?.cached_tokens === "number"
        ? usage.cached_tokens
        : (asRecord(usage?.prompt_tokens_details)?.cached_tokens as number | undefined) ?? 0,
    input: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0,
  });
  recordConversion("chat_json_to_anthropic_json", performance.now() - _t0);
  return {
    id: typeof json.id === "string" ? json.id : `msg_${randomId()}`,
    type: "message",
    role: "assistant",
    model: json.model,
    content,
    stop_reason: mapChatFinishToAnthropic(choice?.finish_reason),
    usage: usage
      ? {
          input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
          output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
          // 保真缓存命中：05B 组合层（Responses→Anthropic）需要 cache 计数跨层透传
          cache_read_input_tokens:
            typeof usage.cached_tokens === "number"
              ? usage.cached_tokens
              : typeof (asRecord(usage.prompt_tokens_details)?.cached_tokens) === "number"
                ? (asRecord(usage.prompt_tokens_details)?.cached_tokens as number)
                : 0,
        }
      : undefined,
  };
}

/** 上游 anthropic JSON → 客户端 chat JSON。 */
export function anthropicJsonToChatJson(
  json: Record<string, unknown>,
  opts: { preserveSignature?: boolean; suppressUsageStat?: boolean } = {},
): Record<string, unknown> {
  const _t0 = performance.now();
  const content = Array.isArray(json.content) ? (json.content as unknown[]) : [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  let reasoningSignature = "";
  const toolCalls: unknown[] = [];
  for (const b of content) {
    const r = asRecord(b);
    if (!r) continue;
    if (r.type === "text" && typeof r.text === "string") textParts.push(r.text);
    else if (r.type === "thinking" && typeof r.thinking === "string") {
      reasoningParts.push(r.thinking);
      if (typeof r.signature === "string") reasoningSignature = r.signature;
    }
    else if (r.type === "tool_use") {
      toolCalls.push({
        id: typeof r.id === "string" ? r.id : `call_${randomId()}`,
        type: "function",
        function: {
          name: r.name ?? "",
          arguments: typeof r.input === "string" ? r.input : JSON.stringify(r.input ?? {}),
        },
      });
    }
  }
  const usage = asRecord(json.usage);
  // suppressUsageStat：组合层（Responses↔Anthropic 两跳）只在最终一跳计一次 usage。
  if (!opts.suppressUsageStat) {
    recordCacheUsage({
      cached:
        typeof usage?.cache_read_input_tokens === "number"
          ? usage.cache_read_input_tokens
          : 0,
      input: typeof usage?.input_tokens === "number" ? usage.input_tokens : 0,
    });
  }
  recordConversion("anthropic_json_to_chat_json", performance.now() - _t0);
  const message: Record<string, unknown> = { role: "assistant", content: textParts.join("\n") || null };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("\n");
  if (opts.preserveSignature && reasoningSignature) {
    message.anthropic_reasoning_signature = reasoningSignature;
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: typeof json.id === "string" ? json.id : `chatcmpl_${randomId()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: json.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapAnthropicStopToChat(json.stop_reason),
      },
    ],
    usage: usage
      ? {
          prompt_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
          completion_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
          total_tokens:
            (typeof usage.input_tokens === "number" ? usage.input_tokens : 0) +
            (typeof usage.output_tokens === "number" ? usage.output_tokens : 0),
          // 保真缓存命中：05B 组合层（Anthropic→Responses）需要 cache 计数跨层透传
          ...(typeof usage.cache_read_input_tokens === "number" && usage.cache_read_input_tokens > 0
            ? {
                cached_tokens: usage.cache_read_input_tokens,
                prompt_tokens_details: { cached_tokens: usage.cache_read_input_tokens },
              }
            : {}),
        }
      : undefined,
  };
}

function mapChatFinishToAnthropic(f: unknown): string {
  if (f === "tool_calls" || f === "function_call") return "tool_use";
  if (f === "length") return "max_tokens";
  return "end_turn"; // stop / content_filter / stop_sequence / null → end_turn（Anthropic 无 content_filter 语义）
}

function mapAnthropicStopToChat(s: unknown): string {
  if (s === "tool_use") return "tool_calls";
  if (s === "max_tokens") return "length";
  return "stop"; // end_turn / stop_sequence / refusal / pause_turn → stop
}

// ── 流式：上游 Anthropic SSE → 客户端 Chat SSE ──────────────────────────────

export function createAnthropicSseToChatSse(
  opts: { model?: string; preserveSignature?: boolean } = {},
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const model = opts.model ?? "unknown";
  recordStream("anthropic_to_chat");
  const parser = createSseFrameParser();
  let started = false;
  let textIndex = -1;
  let reasoningOpen = false;
  let toolStates = new Map<number, { id: string; name: string }>();
  // Anthropic 的 content block index 与 chat 的 tool_calls 序号不是一回事：
  // thinking/text 块也会占用 index。这里按 tool_use 出现顺序重映射为连续序号
  // （0,1,2…），否则 OpenAI 客户端按 index 聚和会错位/丢调用。
  const toolOrdinalByBlock = new Map<number, number>();
  let nextToolOrdinal = 0;
  let stopReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  const toChatUsage = (u: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!u) return undefined;
    const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
    const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
    const cached = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
    return {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
      ...(cached > 0 ? { cached_tokens: cached } : {}),
    };
  };
  let finished = false;
  let controller: TransformStreamDefaultController<Uint8Array> | null = null;

  const emit = (s: string) => {
    if (controller) {
      try {
        controller.enqueue(encoder.encode(s));
      } catch {
        /* ignore */
      }
    }
  };

  const ensureStarted = () => {
    if (started) return;
    started = true;
    emit(
      sseData({
        id: `chatcmpl_${randomId()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      }),
    );
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    if (!started) ensureStarted();
    emit(
      sseData({
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason:
              toolStates.size > 0
                ? "tool_calls"
                : stopReason
                  ? mapAnthropicStopToChat(stopReason)
                  : "stop",
          },
        ],
      }),
    );
    if (usage) {
      emit(sseData({ choices: [], usage: toChatUsage(usage) }));
    }
    emit("data: [DONE]\n\n");
  };

  const handleEvent = (type: string, data: Record<string, unknown>) => {
    if (type === "message_start") {
      usage = asRecord(asRecord(data.message)?.usage) ?? undefined;
      ensureStarted();
      return;
    }
    if (type === "content_block_start") {
      const idx = typeof data.index === "number" ? data.index : -1;
      const block = asRecord(data.content_block);
      if (block?.type === "tool_use") {
        const ordinal = nextToolOrdinal++;
        toolStates.set(idx, {
          id: typeof block.id === "string" ? block.id : `call_${randomId()}`,
          name: typeof block.name === "string" ? block.name : "",
        });
        toolOrdinalByBlock.set(idx, ordinal);
        ensureStarted();
        emit(
          sseData({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: toolOrdinalByBlock.get(idx)!,
                      id: toolStates.get(idx)!.id,
                      type: "function",
                      function: { name: toolStates.get(idx)!.name, arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        );
      } else if (block?.type === "text") {
        textIndex = idx;
      } else if (block?.type === "thinking") {
        reasoningOpen = true;
      }
      return;
    }
    if (type === "content_block_delta") {
      const idx = typeof data.index === "number" ? data.index : -1;
      const delta = asRecord(data.delta);
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        ensureStarted();
        emit(
          sseData({
            choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
          }),
        );
      } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        // 防御：极端情况下 start 帧丢失时按顺序补一个序号，避免把上游块 index 泄漏出去。
        const ordinal =
          toolOrdinalByBlock.get(idx) ??
          (() => {
            const o = nextToolOrdinal++;
            toolOrdinalByBlock.set(idx, o);
            return o;
          })();
        ensureStarted();
        emit(
          sseData({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: ordinal,
                      function: { name: null, arguments: delta.partial_json },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        );
      } else if (
        delta?.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      ) {
        ensureStarted();
        emit(
          sseData({
            choices: [
              {
                index: 0,
                delta: { reasoning_content: delta.thinking },
                finish_reason: null,
              },
            ],
          }),
        );
      } else if (
        opts.preserveSignature &&
        delta?.type === "signature_delta" &&
        typeof delta.signature === "string"
      ) {
        ensureStarted();
        emit(
          sseData({
            choices: [
              {
                index: 0,
                delta: { reasoning_signature: delta.signature },
                finish_reason: null,
              },
            ],
          }),
        );
      }
      return;
    }
    if (type === "message_delta") {
      const u = asRecord(data.usage);
      if (u) usage = { ...(usage ?? {}), ...u };
      const d = asRecord(data.delta);
      if (d && typeof d.stop_reason === "string") stopReason = d.stop_reason;
      return;
    }
    if (type === "error") {
      finished = true;
      emit(sseData({ error: data.error ?? { message: "upstream error" } }));
      return;
    }
    if (type === "message_stop") {
      finish();
      return;
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    start(c) {
      controller = c;
    },
    transform(chunk, c) {
      controller = c;
      for (const frame of parser.push(decoder.decode(chunk, { stream: true }))) {
        const type = frame.event ?? "message";
        try {
          handleEvent(type, JSON.parse(frame.data) as Record<string, unknown>);
        } catch {
          /* skip malformed frame */
        }
      }
    },
    flush() {
      for (const frame of parser.end()) {
        const type = frame.event ?? "message";
        try {
          handleEvent(type, JSON.parse(frame.data) as Record<string, unknown>);
        } catch {
          /* skip malformed tail frame */
        }
      }
      finish();
    },
  });
}

// ── 流式：上游 Chat SSE → 客户端 Anthropic SSE ──────────────────────────────

export function createChatSseToAnthropicSse(
  opts: { model?: string; preserveSignature?: boolean } = {},
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const model = opts.model ?? "unknown";
  recordStream("chat_to_anthropic");
  const parser = createSseFrameParser();
  let started = false;
  let finished = false;
  let nextBlock = 0;
  let thinkingIndex = -1;
  let textIndex = -1;
  let toolIndexByChat = new Map<number, number>();
  let toolIdByName = new Map<string, string>();
  let usage: Record<string, unknown> | undefined;
  let pendingFinishReason: string | undefined;
  let controller: TransformStreamDefaultController<Uint8Array> | null = null;

  const emit = (s: string) => {
    if (controller) {
      try {
        controller.enqueue(encoder.encode(s));
      } catch {
        /* ignore */
      }
    }
  };

  const toAnthropicUsage = (u: Record<string, unknown> | undefined): Record<string, unknown> => {
    if (!u) return {};
    const cached =
      (asRecord(u.prompt_tokens_details)?.cached_tokens as number | undefined) ??
      (u.cached_tokens as number | undefined) ??
      0;
    return {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
      ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
    };
  };

  const ensureStarted = (inputUsage?: Record<string, unknown>) => {
    if (started) return;
    started = true;
    emit(
      anthropicEvent("message_start", {
        type: "message_start",
        message: {
          id: `msg_${randomId()}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          ...(inputUsage ? { usage: inputUsage } : {}),
        },
      }),
    );
  };

  const openThinking = () => {
    if (thinkingIndex >= 0) return;
    thinkingIndex = nextBlock++;
    emit(
      anthropicEvent("content_block_start", {
        type: "content_block_start",
        index: thinkingIndex,
        content_block: { type: "thinking", thinking: "" },
      }),
    );
  };

  const closeThinking = () => {
    if (thinkingIndex < 0) return;
    emit(anthropicEvent("content_block_stop", { type: "content_block_stop", index: thinkingIndex }));
    thinkingIndex = -1;
  };

  const openText = () => {
    if (textIndex >= 0) return;
    textIndex = nextBlock++;
    emit(
      anthropicEvent("content_block_start", {
        type: "content_block_start",
        index: textIndex,
        content_block: { type: "text", text: "" },
      }),
    );
  };

  const closeText = () => {
    if (textIndex < 0) return;
    emit(anthropicEvent("content_block_stop", { type: "content_block_stop", index: textIndex }));
    textIndex = -1;
  };

  const closeTools = () => {
    for (const [chatIdx, aIdx] of toolIndexByChat) {
      void chatIdx;
      emit(anthropicEvent("content_block_stop", { type: "content_block_stop", index: aIdx }));
    }
    toolIndexByChat = new Map();
  };

  const finish = (stopReason?: string) => {
    if (finished) return;
    finished = true;
    // 空内容 / 直接 EOF 也要先发 message_start，否则缺头的 Anthropic SSE 流是非法的。
    ensureStarted();
    closeThinking();
    closeText();
    closeTools();
    emit(
      anthropicEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: stopReason === "tool_calls" ? "tool_use" : stopReason === "length" ? "max_tokens" : "end_turn",
          stop_sequence: null,
        },
        usage: toAnthropicUsage(usage),
      }),
    );
    emit(anthropicEvent("message_stop", { type: "message_stop" }));
  };

  const handleChunk = (evt: Record<string, unknown>) => {
    // usage 可能出现在独立的最终 chunk（choices 为空）里，
    // 必须先于 choices 守卫读取，否则 include_usage 信息会丢。
    const u = asRecord(evt.usage);
    if (u) usage = u;
    const err = asRecord(evt.error);
    if (err) {
      finished = true;
      emit(anthropicEvent("error", { type: "error", error: err }));
      return;
    }
    const choices = Array.isArray(evt.choices) ? (evt.choices as unknown[]) : [];
    const choice = asRecord(choices[0]);
    if (!choice) return;
    const delta = asRecord(choice.delta);
    const finishReason = choice.finish_reason;

    if (delta?.role === "assistant") ensureStarted();

    if (
      typeof delta?.reasoning_content === "string" &&
      delta.reasoning_content.length > 0
    ) {
      ensureStarted();
      openThinking();
      emit(
        anthropicEvent("content_block_delta", {
          type: "content_block_delta",
          index: thinkingIndex,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content },
        }),
      );
    }

    if (
      opts.preserveSignature &&
      typeof delta?.reasoning_signature === "string" &&
      delta.reasoning_signature.length > 0
    ) {
      ensureStarted();
      openThinking();
      emit(
        anthropicEvent("content_block_delta", {
          type: "content_block_delta",
          index: thinkingIndex,
          delta: { type: "signature_delta", signature: delta.reasoning_signature },
        }),
      );
    }

    if (typeof delta?.content === "string" && delta.content.length > 0) {
      ensureStarted();
      openText();
      emit(
        anthropicEvent("content_block_delta", {
          type: "content_block_delta",
          index: textIndex,
          delta: { type: "text_delta", text: delta.content },
        }),
      );
    }

    if (Array.isArray(delta?.tool_calls)) {
      ensureStarted();
      for (const tc of delta.tool_calls as unknown[]) {
        const t = asRecord(tc);
        if (!t) continue;
        const chatIdx = typeof t.index === "number" ? t.index : 0;
        let aIdx = toolIndexByChat.get(chatIdx);
        const fn = asRecord(t.function);
        if (aIdx === undefined) {
          aIdx = nextBlock++;
          toolIndexByChat.set(chatIdx, aIdx);
          const toolId = typeof t.id === "string" ? t.id : `toolu_${randomId()}`;
          toolIdByName.set(String(chatIdx), toolId);
          emit(
            anthropicEvent("content_block_start", {
              type: "content_block_start",
              index: aIdx,
              content_block: {
                type: "tool_use",
                id: toolId,
                name: fn?.name ?? "",
                input: {},
              },
            }),
          );
        }
        if (fn && typeof fn.arguments === "string" && fn.arguments.length > 0) {
          emit(
            anthropicEvent("content_block_delta", {
              type: "content_block_delta",
              index: aIdx,
              delta: { type: "input_json_delta", partial_json: fn.arguments },
            }),
          );
        }
      }
    }

    if (typeof finishReason === "string" && finishReason.length > 0) {
      // 不立即收尾：标准 OpenAI 流在 finish_reason 之后还会发一个独立
      // usage chunk，再发 [DONE]。等到 [DONE]/flush 再 emit message_delta，
      // 这样 message_delta.usage 能带上完整的 input/output/cache 计数。
      pendingFinishReason = finishReason;
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    start(c) {
      controller = c;
    },
    transform(chunk, c) {
      controller = c;
      for (const frame of parser.push(decoder.decode(chunk, { stream: true }))) {
        if (frame.data === "[DONE]") {
          finish(pendingFinishReason);
          continue;
        }
        try {
          handleChunk(JSON.parse(frame.data) as Record<string, unknown>);
        } catch {
          /* skip malformed frame */
        }
      }
    },
    flush() {
      for (const frame of parser.end()) {
        if (frame.data === "[DONE]") {
          finish(pendingFinishReason);
          continue;
        }
        try {
          handleChunk(JSON.parse(frame.data) as Record<string, unknown>);
        } catch {
          /* skip malformed tail frame */
        }
      }
      finish(pendingFinishReason);
    },
  });
}
