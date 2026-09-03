/**
 * OpenAI Responses API ↔ Chat Completions 双向兼容层（TRACK 05B 的中间层）。
 *
 * 背景：WorkBuddy / Codex 等客户端走 OpenAI Responses API（POST /v1/responses，
 * body.input[] + SSE 事件），但智谱 GLM 等上游只实现 Chat Completions
 * （POST /chat/completions + chat.completion.chunk SSE）。本模块负责：
 *
 *   Responses → Chat：
 *   1. responsesBodyToChat()       —— 请求体翻译（input[] → messages）
 *   2. createChatSseToResponses()  —— 上游 chat SSE 逐帧翻译成 Responses SSE
 *   3. chatJsonToResponses()       —— 非流式 JSON 响应翻译
 *
 *   Chat → Responses（反向，TRACK 05B 组合层用）：
 *   4. chatBodyToResponses()       —— 请求体翻译（messages → input[]）
 *   5. createResponsesSseToChatSse()—— 上游 Responses SSE 逐帧翻译成 chat SSE
 *   6. responsesJsonToChatJson()   —— 非流式 JSON 响应翻译
 *
 * 独立性约束：不 import 任何 client handler / adapter，纯函数 + TransformStream，
 * 便于单测与后续 codex 复用。
 */

import { createSseFrameParser, type SseFrameParser } from "./sse.js";
import { recordConversion, recordStream, recordCacheUsage } from "./protocol-stats.js";

// ── 工具函数 ─────────────────────────────────────────────────────────────────

function randomId(): string {
  const hex = Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
  return hex;
}

interface ChatMessage {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: Array<Record<string, unknown>>;
  reasoning_content?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

/** 从 Responses content[] 提取文本片段（input_text / output_text）。 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    if (b.type === "input_text" || b.type === "output_text") {
      if (typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/** 从 Responses content[] 提取图片（input_image），返回图片 url 列表。 */
function extractImages(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const urls: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (!b || b.type !== "input_image") continue;
    const img = asRecord(b.image_url);
    if (img && typeof img.url === "string") urls.push(img.url);
    else if (typeof b.image_url === "string") urls.push(b.image_url);
    else if (typeof b.file_id === "string") urls.push(b.file_id);
  }
  return urls;
}

/**
 * Responses reasoning item 的 summary 字段可能是官方数组形态
 * （[{type:"summary_text", text}]），也可能是部分上游/中间层的字符串形态；
 * 统一抽成纯文本，避免把数组 JSON.stringify 后当摘要。
 */
function reasoningSummaryToText(summary: unknown): string {
  if (typeof summary === "string") return summary;
  if (!Array.isArray(summary)) return "";
  const parts: string[] = [];
  for (const part of summary) {
    if (typeof part === "string") {
      if (part) parts.push(part);
      continue;
    }
    const p = asRecord(part);
    if (p && typeof p.text === "string" && p.text) parts.push(p.text);
  }
  return parts.join("\n");
}

/**
 * 合并相邻同角色消息。
 * 仅合并 system/developer/user 连续消息；assistant 只在无 tool_calls 时合并，
 * tool 消息保持与前面 assistant 的配对关系不被破坏。
 */
function mergeMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    const mergeable =
      !!last &&
      last.role === m.role &&
      ((m.role === "system" || m.role === "developer" || m.role === "user") ||
        (m.role === "assistant" && !last.tool_calls && !m.tool_calls));
    const mergedContent =
      mergeable && typeof last.content === "string" && typeof m.content === "string"
        ? `${last.content}\n\n${m.content}`
        : mergeable && Array.isArray(last.content) && Array.isArray(m.content)
          ? [...last.content, ...m.content]
          : null;
    if (mergedContent !== null) {
      last.content = mergedContent;
    } else {
      out.push({ ...m, content: m.content });
    }
  }
  return out;
}

/**
 * 把 Responses API 请求体翻译成 Chat Completions 请求体。
 * 忽略无法映射的字段（metadata、client_metadata、store 等），保持最小面。
 */
export function responsesBodyToChat(
  body: Record<string, unknown>,
  opts?: { model?: string },
): Record<string, unknown> {
  const _t0 = performance.now();
  // opts.model 为 Proxy 解析后的上游模型名（使用者自定义）；
  // 缺省时沿用客户端请求里的模型名。
  const model = opts?.model ?? (typeof body.model === "string" ? body.model : undefined);
  const instructions = typeof body.instructions === "string" ? body.instructions : "";

  const rawInput = body.input;
  const inputItems: unknown[] = Array.isArray(rawInput)
    ? rawInput
    : rawInput && typeof rawInput === "object"
      ? [rawInput]
      : [];

  const messages: ChatMessage[] = [];
  if (instructions.length > 0) messages.push({ role: "system", content: instructions });
  let pendingReasoning = "";

  for (const raw of inputItems) {
    const item = asRecord(raw);
    if (!item) continue;
    const type = item.type;

    if (type === "message") {
      const role = item.role;
      if (role === "assistant") {
        const text = extractText(item.content);
        if (text.length > 0 || pendingReasoning) {
          messages.push({
            role: "assistant",
            content: text,
            ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}),
          });
          pendingReasoning = "";
        }
      } else if (role === "user") {
        const text = extractText(item.content);
        const images = extractImages(item.content);
        if (images.length > 0) {
          const parts: Array<Record<string, unknown>> = [];
          if (text.length > 0) parts.push({ type: "text", text });
          for (const url of images) parts.push({ type: "image_url", image_url: { url } });
          messages.push({ role: "user", content: parts });
        } else if (text.length > 0) {
          messages.push({ role: "user", content: text });
        }
      } else if (role === "developer" || role === "system") {
        // developer/system 是系统级指令，落成 system 消息而非 user。
        const text = extractText(item.content);
        if (text.length > 0) messages.push({ role: "system", content: text });
      }
    } else if (type === "function_call") {
      const callId = typeof item.call_id === "string" ? item.call_id : `call_${randomId()}`;
      const name = typeof item.name === "string" ? item.name : "";
      const args =
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {});
      const toolCall = { id: callId, type: "function", function: { name, arguments: args } };
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && Array.isArray(last.tool_calls)) {
        last.tool_calls.push(toolCall);
      } else if (last && last.role === "assistant" && typeof last.content === "string") {
        last.tool_calls = [toolCall];
      } else {
        messages.push({ role: "assistant", content: "", tool_calls: [toolCall] });
      }
    } else if (type === "function_call_output") {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      const output =
        typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      if (callId) messages.push({ role: "tool", tool_call_id: callId, content: output });
    } else if (type === "reasoning") {
      const summary = reasoningSummaryToText(item.summary);
      if (summary) {
        pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${summary}` : summary;
      }
    }
  }

  const chat: Record<string, unknown> = {
    model,
    messages: mergeMessages(messages),
    stream: true,
  };

  // tools: Responses {type:"function", name, description, parameters} → Chat 标准格式
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools: Array<Record<string, unknown>> = [];
    for (const rawTool of body.tools) {
      const t = asRecord(rawTool);
      if (!t) continue;
      if (t.type === "function" || typeof t.name === "string") {
        const fn: Record<string, unknown> = {
          name: typeof t.name === "string" ? t.name : "",
          description: typeof t.description === "string" ? t.description : undefined,
          parameters: asRecord(t.parameters) ?? undefined,
        };
        tools.push({ type: "function", function: fn });
      }
      // custom 工具无法映射，跳过（避免上游 400）
    }
    if (tools.length > 0) chat.tools = tools;
  }

  // tool_choice: Responses "auto"|"none"|"required"|{type, name} → Chat 格式
  const tc = body.tool_choice;
  if (typeof tc === "string") {
    chat.tool_choice = tc;
  } else {
    const tco = asRecord(tc);
    if (tco && tco.type === "function") {
      const name = typeof tco.name === "string" ? tco.name : "";
      chat.tool_choice = name ? { type: "function", function: { name } } : "auto";
    }
  }

  // token 上限：Responses 用 max_output_tokens / max_completion_tokens，
  // Chat 用 max_tokens；智谱上限 32768。
  const maxTokens =
    typeof body.max_output_tokens === "number"
      ? body.max_output_tokens
      : typeof body.max_completion_tokens === "number"
        ? body.max_completion_tokens
        : undefined;
  if (typeof maxTokens === "number" && maxTokens >= 1) {
    // 智谱只接受 [1, 32768]；0 / 负数表示"不限制"，直接不传让上游用默认值
    chat.max_tokens = Math.min(maxTokens, 32768);
  }

  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (body.parallel_tool_calls !== undefined) chat.parallel_tool_calls = body.parallel_tool_calls;

  recordConversion("responses_body_to_chat", performance.now() - _t0);
  return chat;
}

// ── 流式转换：chat.completion.chunk SSE → Responses SSE ──────────────────────

interface OpenItem {
  kind: "text" | "tool" | "reasoning";
  outputIndex: number;
  itemId: string;
  text?: string;
  callId?: string;
  name?: string;
  args?: string;
  finished?: boolean;
}

function sseFrame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** Chat Completions SSE 数据帧（无 event 行）。 */
function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function textItemDoneEvents(item: OpenItem): string[] {
  const text = item.text ?? "";
  return [
    sseFrame("response.output_text.done", {
      item_id: item.itemId,
      output_index: item.outputIndex,
      content_index: 0,
      text,
    }),
    sseFrame("response.content_part.done", {
      item_id: item.itemId,
      output_index: item.outputIndex,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    }),
    sseFrame("response.output_item.done", {
      output_index: item.outputIndex,
      item: {
        id: item.itemId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    }),
  ];
}

function toolItemDoneEvents(item: OpenItem): string[] {
  const args = item.args ?? "";
  return [
    sseFrame("response.function_call_arguments.done", {
      item_id: item.itemId,
      output_index: item.outputIndex,
      arguments: args,
    }),
    sseFrame("response.output_item.done", {
      output_index: item.outputIndex,
      item: {
        id: item.itemId,
        type: "function_call",
        status: "completed",
        call_id: item.callId ?? item.itemId,
        name: item.name ?? "",
        arguments: args,
      },
    }),
  ];
}

function reasoningItemDoneEvents(item: OpenItem): string[] {
  const text = item.text ?? "";
  return [
    sseFrame("response.reasoning_summary_text.done", {
      item_id: item.itemId,
      output_index: item.outputIndex,
      summary_index: 0,
      text,
    }),
    sseFrame("response.reasoning_summary_part.done", {
      item_id: item.itemId,
      output_index: item.outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text },
    }),
    sseFrame("response.output_item.done", {
      output_index: item.outputIndex,
      item: {
        id: item.itemId,
        type: "reasoning",
        status: "completed",
        summary: text ? [{ type: "summary_text", text }] : [],
      },
    }),
  ];
}

function finalItemShape(item: OpenItem): Record<string, unknown> {
  if (item.kind === "reasoning") {
    const text = item.text ?? "";
    return {
      id: item.itemId,
      type: "reasoning",
      status: "completed",
      summary: text ? [{ type: "summary_text", text }] : [],
    };
  }
  if (item.kind === "text") {
    return {
      id: item.itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: item.text ?? "", annotations: [] }],
    };
  }
  return {
    id: item.itemId,
    type: "function_call",
    status: "completed",
    call_id: item.callId ?? item.itemId,
    name: item.name ?? "",
    arguments: item.args ?? "",
  };
}

/**
 * 创建一个 TransformStream：把上游 Chat Completions 的 SSE 字节流逐帧翻译成
 * Responses API 的 SSE 事件（response.created / output_text.delta /
 * output_item.done / response.completed）。@openai/agents SDK 可直接消费。
 */
export function createChatSseToResponses(opts: {
  model?: string;
}): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const model = typeof opts.model === "string" ? opts.model : "unknown";
  recordStream("chat_to_responses");

  let state: {
    responseId: string;
    created: number;
    parser: SseFrameParser;
    items: OpenItem[];
    textItem: OpenItem | null;
    /** Chat tool_calls index → 已开启的 function_call 输出项。 */
    toolsByChatIndex: Map<number, OpenItem>;
    usage: Record<string, unknown> | undefined;
    finished: boolean;
    controller: TransformStreamDefaultController<Uint8Array>;
  } | null = null;

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      const responseId = `resp_${randomId()}`;
      const created = Math.floor(Date.now() / 1000);
      state = {
        responseId,
        created,
        parser: createSseFrameParser(),
        items: [],
        textItem: null,
        toolsByChatIndex: new Map<number, OpenItem>(),
        usage: undefined,
        finished: false,
        controller,
      };
      controller.enqueue(
        encoder.encode(
          sseFrame("response.created", {
            response: {
              id: responseId,
              object: "response",
              created_at: created,
              status: "in_progress",
              model,
              output: [],
            },
          }),
        ),
      );
    },
    transform(chunk, controller) {
      if (!state) return;
      for (const frame of state.parser.push(decoder.decode(chunk, { stream: true }))) {
        if (frame.data === "[DONE]") {
          complete();
          continue;
        }
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(frame.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        handleChatChunk(evt);
      }
    },
    flush() {
      if (!state) return;
      for (const frame of state.parser.end()) {
        if (frame.data === "[DONE]") {
          complete();
          continue;
        }
        try {
          handleChatChunk(JSON.parse(frame.data) as Record<string, unknown>);
        } catch {
          /* skip malformed tail frame */
        }
      }
      // 上游可能不发送 [DONE]，直接收尾
      complete();
      state = null;
    },
  });

  function emit(s: string) {
    if (state) {
      try {
        state.controller.enqueue(encoder.encode(s));
      } catch {
        /* client 断开时忽略 */
      }
    }
  }

  function addItem(item: OpenItem): void {
    if (!state) return;
    item.outputIndex = state.items.length;
    state.items.push(item);
  }

  function startTextItem() {
    if (!state) return;
    if (state.textItem) return;
    const item: OpenItem = {
      kind: "text",
      outputIndex: 0,
      itemId: `msg_${randomId()}`,
      text: "",
    };
    addItem(item);
    state.textItem = item;
    emit(
      sseFrame("response.output_item.added", {
        output_index: item.outputIndex,
        item: {
          id: item.itemId,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      }),
    );
    emit(
      sseFrame("response.content_part.added", {
        item_id: item.itemId,
        output_index: item.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
    );
  }

  function startReasoningItem() {
    if (!state) return;
    if (state.items.some((i) => i.kind === "reasoning")) return;
    const item: OpenItem = {
      kind: "reasoning",
      outputIndex: 0,
      itemId: `rs_${randomId()}`,
      text: "",
    };
    addItem(item);
    emit(
      sseFrame("response.output_item.added", {
        output_index: item.outputIndex,
        item: {
          id: item.itemId,
          type: "reasoning",
          status: "in_progress",
          summary: [],
        },
      }),
    );
    emit(
      sseFrame("response.reasoning_summary_part.added", {
        item_id: item.itemId,
        output_index: item.outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }),
    );
  }

  function feedTextDelta(delta: string) {
    if (!state) return;
    if (!state.textItem) startTextItem();
    const item = state.textItem;
    if (!item) return;
    item.text = (item.text ?? "") + delta;
    emit(
      sseFrame("response.output_text.delta", {
        item_id: item.itemId,
        output_index: item.outputIndex,
        content_index: 0,
        delta,
      }),
    );
  }

  function feedReasoningDelta(delta: string) {
    if (!state) return;
    if (!state.items.some((i) => i.kind === "reasoning")) startReasoningItem();
    const item = state.items.find((i) => i.kind === "reasoning");
    if (!item) return;
    item.text = (item.text ?? "") + delta;
    emit(
      sseFrame("response.reasoning_summary_text.delta", {
        item_id: item.itemId,
        output_index: item.outputIndex,
        summary_index: 0,
        delta,
      }),
    );
  }

  function feedToolDelta(
    index: number,
    id: string | undefined,
    name: string | undefined,
    argsDelta: string | undefined,
  ) {
    if (!state) return;
    let item = state.toolsByChatIndex.get(index);
    if (!item) {
      const callId = id ?? `call_${randomId()}`;
      item = {
        kind: "tool",
        outputIndex: 0,
        itemId: callId.startsWith("call_") ? callId : `call_${randomId()}`,
        callId,
        name: name ?? "",
        args: "",
      };
      addItem(item);
      state.toolsByChatIndex.set(index, item);
      emit(
        sseFrame("response.output_item.added", {
          output_index: item.outputIndex,
          item: {
            id: item.itemId,
            type: "function_call",
            status: "in_progress",
            call_id: item.callId,
            name: item.name,
            arguments: "",
          },
        }),
      );
    } else {
      if (id) item.callId = id;
      if (name) item.name = name;
    }
    if (argsDelta) {
      item.args = (item.args ?? "") + argsDelta;
      emit(
        sseFrame("response.function_call_arguments.delta", {
          item_id: item.itemId,
          output_index: item.outputIndex,
          delta: argsDelta,
        }),
      );
    }
  }

  function handleChatChunk(evt: Record<string, unknown>) {
    if (!state) return;
    const err = asRecord(evt.error);
    if (err) {
      // 上游 chat 内联错误帧 → Responses response.failed（错误不再被静默吞掉）
      state.finished = true;
      emit(sseFrame("response.failed", { type: "response.failed", error: err }));
      return;
    }
    if (evt.usage && typeof evt.usage === "object") {
      state.usage = evt.usage as Record<string, unknown>;
    }
    const choices = Array.isArray(evt.choices) ? (evt.choices as unknown[]) : [];
    for (const rawChoice of choices) {
      const choice = asRecord(rawChoice);
      if (!choice) continue;
      const delta = asRecord(choice.delta) ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        feedTextDelta(delta.content);
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        feedReasoningDelta(delta.reasoning_content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const rawTc of delta.tool_calls as unknown[]) {
          const tc = asRecord(rawTc);
          if (!tc) continue;
          const idx = typeof tc.index === "number" ? tc.index : 0;
          const fn = asRecord(tc.function) ?? {};
          feedToolDelta(
            idx,
            typeof tc.id === "string" ? tc.id : undefined,
            typeof fn.name === "string" ? fn.name : undefined,
            typeof fn.arguments === "string" ? fn.arguments : undefined,
          );
        }
      }
      // finish_reason 只记录，不立即 complete —— 等 [DONE] / 流结束，
      // 避免丢掉最后一块 usage
    }
  }

  function complete() {
    if (!state || state.finished) return;
    state.finished = true;
    // 收尾：所有已开启的输出项按 output_index 顺序发 done 事件；
    // 并行工具各自持有独立 item，参数不会再串到其它调用上。
    for (const item of state.items) {
      if (item.kind === "reasoning") {
        for (const e of reasoningItemDoneEvents(item)) emit(e);
      } else if (item.kind === "text") {
        for (const e of textItemDoneEvents(item)) emit(e);
      } else {
        for (const e of toolItemDoneEvents(item)) emit(e);
      }
    }
    const usage = state.usage;
    // usage 保真：保留上游 chat usage 的缓存命中字段（Responses 侧用
    // cached_tokens 单独暴露），避免转换层丢失缓存/计费信息。
    const cachedTokens =
      (asRecord(usage?.prompt_tokens_details)?.cached_tokens as number | undefined) ??
      (usage?.cached_tokens as number | undefined) ??
      0;
    emit(
      sseFrame("response.completed", {
        response: {
          id: state.responseId,
          object: "response",
          created_at: state.created,
          status: "completed",
          model,
          output: state.items.map(finalItemShape),
          usage:
            usage && Object.keys(usage).length > 0
              ? {
                  input_tokens: usage.prompt_tokens ?? 0,
                  output_tokens: usage.completion_tokens ?? 0,
                  total_tokens: usage.total_tokens ?? 0,
                  cached_tokens: cachedTokens,
                  input_tokens_details:
                    cachedTokens > 0 ? { cached_tokens: cachedTokens } : undefined,
                }
              : undefined,
        },
      }),
    );
  }
}

/**
 * 把非流式 Chat Completions JSON 响应翻译成 Responses API JSON。
 * 当前上游统一走 stream:true，此函数作为兜底保留。
 */
export function chatJsonToResponses(
  json: Record<string, unknown>,
  opts: { model?: string },
): Record<string, unknown> {
  const _t0 = performance.now();
  const choices = Array.isArray(json.choices) ? (json.choices as unknown[]) : [];
  const choice = asRecord(choices[0]) ?? {};
  const message = asRecord(choice.message) ?? {};
  const output: Record<string, unknown>[] = [];

  const reasoning =
    typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  if (reasoning.length > 0) {
    output.push({
      id: `rs_${randomId()}`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoning }],
    });
  }

  const content = typeof message.content === "string" ? message.content : "";
  if (content.length > 0) {
    output.push({
      id: `msg_${randomId()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content, annotations: [] }],
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const rawTc of message.tool_calls as unknown[]) {
      const tc = asRecord(rawTc);
      if (!tc) continue;
      const fn = asRecord(tc.function) ?? {};
      const callId = typeof tc.id === "string" ? tc.id : `call_${randomId()}`;
      output.push({
        id: callId,
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: typeof fn.name === "string" ? fn.name : "",
        arguments: typeof fn.arguments === "string" ? fn.arguments : "",
      });
    }
  }

  const usage = asRecord(json.usage) ?? {};
  recordCacheUsage({
    cached:
      (asRecord(usage.prompt_tokens_details)?.cached_tokens as number | undefined) ??
      (usage.cached_tokens as number | undefined) ??
      0,
    input: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
  });
  recordConversion("chat_json_to_responses", performance.now() - _t0);
  return {
    id: `resp_${randomId()}`,
    object: "response",
    created_at:
      typeof json.created === "number" ? json.created : Math.floor(Date.now() / 1000),
    status: "completed",
    model: opts.model ?? (typeof json.model === "string" ? json.model : ""),
    output,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      cached_tokens:
        (asRecord(usage.prompt_tokens_details)?.cached_tokens as number | undefined) ??
        (usage.cached_tokens as number | undefined) ??
        0,
    },
  };
}

// ── 请求体：Chat → Responses（反向）─────────────────────────────────────────

/** 从 Chat messages[].content 提取文本 + 图片 url（text / image_url 两种 part）。 */
function chatContentParts(content: unknown): { text: string; images: string[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const textParts: string[] = [];
  const images: string[] = [];
  for (const p of content) {
    const r = asRecord(p);
    if (!r) continue;
    if (r.type === "text" && typeof r.text === "string") textParts.push(r.text);
    else if (r.type === "image_url") {
      const iu = asRecord(r.image_url);
      const url = typeof r.image_url === "string" ? r.image_url : iu?.url;
      if (typeof url === "string") images.push(url);
    }
  }
  return { text: textParts.join("\n"), images };
}

/**
 * 把 Chat Completions 请求体翻译成 Responses API 请求体。
 * 反向组合（Anthropic → Chat → Responses）时作为第二跳使用：
 * system → instructions；tool 消息 → function_call_output；
 * assistant + tool_calls → message + function_call 序列。
 */
export function chatBodyToResponses(
  body: Record<string, unknown>,
  opts?: { model?: string },
): Record<string, unknown> {
  const _t0 = performance.now();
  const model = opts?.model ?? (typeof body.model === "string" ? body.model : undefined);
  const input: Array<Record<string, unknown>> = [];
  let instructions = "";

  for (const raw of Array.isArray(body.messages) ? (body.messages as unknown[]) : []) {
    const m = asRecord(raw);
    if (!m) continue;
    const role = m.role;
    if (role === "system" || role === "developer") {
      const text = chatContentParts(m.content).text;
      instructions = instructions ? `${instructions}\n\n${text}` : text;
      continue;
    }
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: typeof m.tool_call_id === "string" ? m.tool_call_id : "",
        output: chatContentParts(m.content).text,
      });
      continue;
    }
    if (role === "assistant") {
      const { text } = chatContentParts(m.content);
      input.push({
        type: "message",
        role: "assistant",
        content: text ? [{ type: "output_text", text }] : [],
      });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as unknown[]) {
          const t = asRecord(tc);
          if (!t) continue;
          const fn = asRecord(t.function);
          input.push({
            type: "function_call",
            call_id: typeof t.id === "string" ? t.id : `call_${randomId()}`,
            name: typeof fn?.name === "string" ? fn.name : "",
            arguments:
              typeof fn?.arguments === "string"
                ? fn.arguments
                : JSON.stringify(fn?.arguments ?? {}),
          });
        }
      }
      continue;
    }
    // user（及未知角色统一按 user 处理）
    const { text, images } = chatContentParts(m.content);
    const contentParts: unknown[] = [];
    if (text) contentParts.push({ type: "input_text", text });
    for (const url of images) contentParts.push({ type: "input_image", image_url: { url } });
    input.push({
      type: "message",
      role: "user",
      content: contentParts.length > 0 ? contentParts : [{ type: "input_text", text: "" }],
    });
  }

  const out: Record<string, unknown> = {
    model,
    input,
    stream: true,
  };
  if (instructions) out.instructions = instructions;

  if (Array.isArray(body.tools)) {
    const tools: unknown[] = [];
    for (const t of body.tools as unknown[]) {
      const r = asRecord(t);
      const fn = asRecord(r?.function);
      if (!r || !fn || typeof fn.name !== "string") continue;
      tools.push({
        type: "function",
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : undefined,
        parameters: fn.parameters ?? { type: "object", properties: {} },
      });
    }
    if (tools.length > 0) out.tools = tools;
  }

  const tc = body.tool_choice;
  if (typeof tc === "string") {
    out.tool_choice = tc;
  } else {
    const tco = asRecord(tc);
    if (tco && tco.type === "function") {
      const fn = asRecord(tco.function);
      const name = fn && typeof fn.name === "string" ? fn.name : "";
      out.tool_choice = name ? { type: "function", name } : "auto";
    }
  }

  // Chat max_tokens → Responses max_output_tokens（保留智谱上限钳制）
  if (typeof body.max_tokens === "number" && body.max_tokens >= 1) {
    out.max_output_tokens = Math.min(body.max_tokens, 32768);
  }
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;
  recordConversion("chat_body_to_responses", performance.now() - _t0);
  return out;
}

// ── 流式转换：Responses SSE → chat.completion.chunk SSE（反向）───────────────

/**
 * 创建一个 TransformStream：把上游 Responses API 的 SSE 事件流逐帧翻译成
 * Chat Completions SSE（output_text.delta → content delta；function_call → tool_calls
 * delta；response.completed 的 usage → 最终 usage chunk + [DONE]）。
 * 与 createChatSseToResponses 互逆，供 TRACK 05B 组合层第二跳使用。
 */
export function createResponsesSseToChatSse(opts: {
  model?: string;
}): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const model = typeof opts.model === "string" ? opts.model : "unknown";
  recordStream("responses_to_chat");

  let state: {
    parser: SseFrameParser;
    started: boolean;
    finished: boolean;
    chatId: string;
    created: number;
    toolByOutputIndex: Map<number, { chatIndex: number; callId: string; name: string }>;
    toolCount: number;
    usage: Record<string, unknown> | undefined;
    controller: TransformStreamDefaultController<Uint8Array>;
  } | null = null;

  const emit = (s: string) => {
    if (state) {
      try {
        state.controller.enqueue(encoder.encode(s));
      } catch {
        /* client 断开时忽略 */
      }
    }
  };

  const ensureStarted = () => {
    if (!state || state.started) return;
    state.started = true;
    emit(
      sseData({
        id: state.chatId,
        object: "chat.completion.chunk",
        created: state.created,
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
    if (!state || state.finished) return;
    state.finished = true;
    ensureStarted();
    const finishReason = state.toolCount > 0 ? "tool_calls" : "stop";
    emit(
      sseData({
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
          },
        ],
      }),
    );
    const usage = state.usage;
    if (usage && Object.keys(usage).length > 0) {
      const cached =
        (asRecord(usage.input_tokens_details)?.cached_tokens as number | undefined) ??
        (usage.cached_tokens as number | undefined) ??
        0;
      emit(
        sseData({
          choices: [],
          usage: {
            prompt_tokens: usage.input_tokens ?? 0,
            completion_tokens: usage.output_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0,
            ...(cached > 0 ? { cached_tokens: cached } : {}),
            ...(cached > 0
              ? { prompt_tokens_details: { cached_tokens: cached } }
              : {}),
          },
        }),
      );
    }
    emit("data: [DONE]\n\n");
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      state = {
        parser: createSseFrameParser(),
        started: false,
        finished: false,
        chatId: `chatcmpl_${randomId()}`,
        created: Math.floor(Date.now() / 1000),
        toolByOutputIndex: new Map(),
        toolCount: 0,
        usage: undefined,
        controller,
      };
    },
    transform(chunk, controller) {
      if (!state) return;
      state.controller = controller;
      for (const frame of state.parser.push(decoder.decode(chunk, { stream: true }))) {
        const type = frame.event ?? "message";
        try {
          handleEvent(type, JSON.parse(frame.data) as Record<string, unknown>);
        } catch {
          /* skip malformed frame */
        }
      }
    },
    flush() {
      if (!state) return;
      for (const frame of state.parser.end()) {
        const type = frame.event ?? "message";
        try {
          handleEvent(type, JSON.parse(frame.data) as Record<string, unknown>);
        } catch {
          /* skip malformed tail frame */
        }
      }
      finish();
      state = null;
    },
  });

  function handleEvent(type: string, data: Record<string, unknown>) {
    if (!state) return;
    if (type === "response.output_item.added") {
      const item = asRecord(data.item);
      if (item?.type === "function_call") {
        const outputIndex = typeof data.output_index === "number" ? data.output_index : state.toolCount;
        const chatIndex = state.toolCount;
        const callId =
          (typeof item.call_id === "string" ? item.call_id : undefined) ??
          (typeof item.id === "string" ? item.id : undefined) ??
          `call_${randomId()}`;
        const name = typeof item.name === "string" ? item.name : "";
        state.toolByOutputIndex.set(outputIndex, { chatIndex, callId, name });
        state.toolCount += 1;
        ensureStarted();
        emit(
          sseData({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: chatIndex,
                      id: callId,
                      type: "function",
                      function: { name, arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        );
      }
      return;
    }
    if (type === "response.reasoning_summary_text.delta") {
      const delta = data.delta;
      if (typeof delta === "string" && delta.length > 0) {
        ensureStarted();
        emit(
          sseData({
            choices: [
              {
                index: 0,
                delta: { reasoning_content: delta },
                finish_reason: null,
              },
            ],
          }),
        );
      }
      return;
    }
    if (type === "response.output_text.delta") {
      const delta = data.delta;
      if (typeof delta === "string" && delta.length > 0) {
        ensureStarted();
        emit(
          sseData({
            choices: [
              { index: 0, delta: { content: delta }, finish_reason: null },
            ],
          }),
        );
      }
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      const delta = data.delta;
      if (typeof delta === "string" && delta.length > 0) {
        ensureStarted();
        const outputIndex = typeof data.output_index === "number" ? data.output_index : 0;
        let tool = state.toolByOutputIndex.get(outputIndex);
        if (!tool) {
          tool = {
            chatIndex: state.toolCount,
            callId: `call_${randomId()}`,
            name: "",
          };
          state.toolByOutputIndex.set(outputIndex, tool);
          state.toolCount += 1;
        }
        emit(
          sseData({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: tool.chatIndex,
                      function: { name: null, arguments: delta },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        );
      }
      return;
    }
    if (type === "response.completed") {
      const resp = asRecord(data.response);
      if (resp) {
        const usage = asRecord(resp.usage);
        if (usage) state.usage = usage;
      }
      finish();
      return;
    }
    if (type === "response.incomplete") {
      const resp = asRecord(data.response);
      if (resp) {
        const usage = asRecord(resp.usage);
        if (usage) state.usage = usage;
      }
      finish();
      return;
    }
    if (type === "response.failed") {
      const err = asRecord(data.error);
      if (err) {
        // 上游失败原因透传给 chat 客户端（内联 error 帧，终止流）
        emit(sseData({ error: err }));
        state.finished = true;
      } else {
        finish();
      }
      return;
    }
  }
}

// ── 非流式 JSON：Responses → Chat（反向）────────────────────────────────────

/**
 * 把非流式 Responses API JSON 响应翻译成 Chat Completions JSON。
 * 与 chatJsonToResponses 互逆，供 TRACK 05B 组合层第二跳使用。
 */
export function responsesJsonToChatJson(
  json: Record<string, unknown>,
  opts: { model?: string; suppressUsageStat?: boolean },
): Record<string, unknown> {
  const _t0 = performance.now();
  const output = Array.isArray(json.output) ? (json.output as unknown[]) : [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: unknown[] = [];
  let hasToolCall = false;

  for (const item of output) {
    const it = asRecord(item);
    if (!it) continue;
    if (it.type === "message") {
      const content = it.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = asRecord(block);
          if (!b) continue;
          if ((b.type === "output_text" || b.type === "text") && typeof b.text === "string") {
            textParts.push(b.text);
          }
        }
      } else if (typeof content === "string") {
        textParts.push(content);
      }
    } else if (it.type === "function_call") {
      hasToolCall = true;
      const callId =
        (typeof it.call_id === "string" ? it.call_id : undefined) ??
        (typeof it.id === "string" ? it.id : undefined) ??
        `call_${randomId()}`;
      toolCalls.push({
        id: callId,
        type: "function",
        function: {
          name: typeof it.name === "string" ? it.name : "",
          arguments:
            typeof it.arguments === "string"
              ? it.arguments
              : JSON.stringify(it.arguments ?? {}),
        },
      });
    } else if (it.type === "reasoning") {
      const summary = reasoningSummaryToText(it.summary);
      if (summary) reasoningParts.push(summary);
    }
  }

  const usage = asRecord(json.usage) ?? {};
  const cached =
    (asRecord(usage.input_tokens_details)?.cached_tokens as number | undefined) ??
    (usage.cached_tokens as number | undefined) ??
    0;
  // suppressUsageStat：组合层（Responses↔Anthropic 两跳）只在最终一跳计一次 usage。
  if (!opts.suppressUsageStat) {
    recordCacheUsage({ cached, input: typeof usage.input_tokens === "number" ? usage.input_tokens : 0 });
  }
  recordConversion("responses_json_to_chat_json", performance.now() - _t0);
  const message: Record<string, unknown> = {
    role: "assistant",
    content: textParts.join("\n") || null,
  };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("\n");
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: typeof json.id === "string" ? json.id : `chatcmpl_${randomId()}`,
    object: "chat.completion",
    created:
      typeof json.created_at === "number"
        ? json.created_at
        : Math.floor(Date.now() / 1000),
    model: opts.model ?? (typeof json.model === "string" ? json.model : ""),
    choices: [
      {
        index: 0,
        message,
        finish_reason: hasToolCall ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      ...(cached > 0 ? { cached_tokens: cached } : {}),
      ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    },
  };
}
