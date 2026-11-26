/**
 * 从客户端那一路响应里收齐本轮的 tool call，供结束帧放行前的 CFQ 结算使用。
 *
 * 收的是**模型原始参数**（含注入字段）：剥离器改的是另行解析出的事件对象，
 * 这里独立解析同一块 SSE 文本，互不影响。
 *
 * 只做收集与结束帧识别，不改任何字节。解析失败的块直接跳过——结算是尽力而为，
 * 坏块不该影响响应本身。
 */

import type { UpstreamToolCall } from "../request-prepare-adapter.js";
import {
  collectResponsesToolCalls,
  mergeResponsesToolCalls,
  serializeArguments,
} from "./responses-payload.js";

export type SettleCollectProtocol = "anthropic" | "openai" | "responses";

export interface ToolCallCollector {
  /**
   * 观察一个完整的 SSE 事件块（不含结尾空行）。
   * 返回 true 表示这一块是响应的结束帧，必须在它发给客户端之前完成结算。
   */
  observe(block: string): boolean;
  /** 到目前为止收齐的 tool call。上游以失败收尾时为空：失败的响应不会被执行。 */
  calls(): UpstreamToolCall[];
  /** 收集过程中的异常计数，供调用方打日志。不改变收集结果。 */
  diagnostics(): CollectorDiagnostics;
}

export interface CollectorDiagnostics {
  /** 观察过的非空块数。 */
  blocks: number;
  /** `data:` 行不是合法 JSON 对象的块数——这些块里的 tool call 分片会丢。 */
  parseErrors: number;
  /** 识别到的结束帧类型；null 表示上游没发结束帧。 */
  endFrame: string | null;
  /** Responses 以 `response.failed` 收尾。 */
  failed: boolean;
  /** 结算时仍未收口的 tool call 块（Anthropic 缺 `content_block_stop`）。 */
  unclosed: number;
  /** 因缺 id / call_id 被丢弃的 tool call 数——它们的 CFQ 下一轮无法回填。 */
  droppedNoId: number;
}

function newDiagnostics(): CollectorDiagnostics {
  return { blocks: 0, parseErrors: 0, endFrame: null, failed: false, unclosed: 0, droppedNoId: 0 };
}

/** 一行是 `data:` 字段时返回它的值（按规范去掉冒号后的一个空格），否则 null。 */
export function sseDataValue(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  return line.slice(line.startsWith("data: ") ? 6 : 5);
}

/**
 * 一个 SSE 事件块的 data 载荷：按规范把所有 `data:` 行的值用 `\n` 拼接。
 * 没有 data 行时返回 null。
 */
export function joinSseData(block: string): string | null {
  let values: string[] | null = null;
  for (const line of block.split(/\r?\n/)) {
    const value = sseDataValue(line);
    if (value !== null) (values ??= []).push(value);
  }
  return values ? values.join("\n") : null;
}

function parseData(
  block: string,
  diag?: CollectorDiagnostics,
): Record<string, unknown> | "done" | null {
  if (diag) diag.blocks++;
  const data = joinSseData(block);
  if (data === null || data === "") return null;
  if (data === "[DONE]") return "done";
  try {
    const parsed = JSON.parse(data) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    if (diag) diag.parseErrors++;
    return null;
  } catch {
    if (diag) diag.parseErrors++;
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Anthropic：`content_block_start(tool_use)` 起、`input_json_delta` 拼参数、
 * `content_block_stop` 收口。结束帧是带 `stop_reason` 的 `message_delta`；
 * 上游漏发它时退到 `message_stop`。
 */
function createAnthropicCollector(): ToolCallCollector {
  const open = new Map<number, { id: string; name: string; buf: string; input: unknown }>();
  const done: UpstreamToolCall[] = [];
  const diag = newDiagnostics();

  const close = (index: number): void => {
    const entry = open.get(index);
    if (!entry) return;
    open.delete(index);
    done.push({
      id: entry.id,
      name: entry.name,
      arguments: entry.buf !== "" ? entry.buf : serializeArguments(entry.input),
    });
  };

  return {
    observe(block) {
      const evt = parseData(block, diag);
      if (!evt || evt === "done") return false;
      const index = typeof evt.index === "number" ? evt.index : -1;
      switch (evt.type) {
        case "content_block_start": {
          const cb = asRecord(evt.content_block);
          if (cb?.type !== "tool_use") return false;
          if (index >= 0 && typeof cb.id === "string" && cb.id) {
            open.set(index, {
              id: cb.id,
              name: typeof cb.name === "string" ? cb.name : "",
              buf: "",
              input: cb.input,
            });
          } else {
            diag.droppedNoId++;
          }
          return false;
        }
        case "content_block_delta": {
          const entry = open.get(index);
          const delta = asRecord(evt.delta);
          if (entry && delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            entry.buf += delta.partial_json;
          }
          return false;
        }
        case "content_block_stop":
          close(index);
          return false;
        case "message_delta": {
          const delta = asRecord(evt.delta);
          const end = delta?.stop_reason !== null && delta?.stop_reason !== undefined;
          if (end) diag.endFrame ??= "message_delta";
          return end;
        }
        case "message_stop":
          diag.endFrame ??= "message_stop";
          return true;
        default:
          return false;
      }
    },
    calls() {
      // 未收口的块（上游没发 stop）也算：参数可能完整，可能不完整，交给扩展判断。
      diag.unclosed += open.size;
      for (const index of [...open.keys()]) close(index);
      return done.slice();
    },
    diagnostics: () => ({ ...diag }),
  };
}

/**
 * OpenAI Chat：按 `choice:index` 拼 `function.arguments`。结束帧是第一个带
 * `finish_reason` 的 chunk；上游漏发时退到 `[DONE]`。
 *
 * 多 choice（n>1）在第一个 choice 收尾时就结算，其余 choice 之后的分片不再计入。
 * agent 场景不会用 n>1。
 */
function createChatCollector(): ToolCallCollector {
  const entries = new Map<string, { id: string; name: string; buf: string }>();
  const diag = newDiagnostics();

  return {
    observe(block) {
      const evt = parseData(block, diag);
      if (evt === "done") {
        diag.endFrame ??= "[DONE]";
        return true;
      }
      if (!evt) return false;
      const choices = evt.choices;
      if (!Array.isArray(choices)) return false;
      let finished = false;
      for (const choice of choices) {
        const ch = asRecord(choice);
        if (!ch) continue;
        if (ch.finish_reason !== null && ch.finish_reason !== undefined) finished = true;
        const toolCalls = asRecord(ch.delta)?.tool_calls;
        if (!Array.isArray(toolCalls)) continue;
        const choiceIndex = typeof ch.index === "number" ? ch.index : 0;
        for (const tc of toolCalls) {
          const t = asRecord(tc);
          if (!t) continue;
          const key = `${choiceIndex}:${typeof t.index === "number" ? t.index : 0}`;
          let entry = entries.get(key);
          if (!entry) {
            entry = { id: "", name: "", buf: "" };
            entries.set(key, entry);
          }
          if (typeof t.id === "string" && t.id) entry.id = t.id;
          const fn = asRecord(t.function);
          if (typeof fn?.name === "string" && fn.name) entry.name = fn.name;
          if (typeof fn?.arguments === "string") entry.buf += fn.arguments;
          else if (asRecord(fn?.arguments)) entry.buf = serializeArguments(fn!.arguments);
        }
      }
      if (finished) diag.endFrame ??= "finish_reason";
      return finished;
    },
    calls() {
      const out: UpstreamToolCall[] = [];
      let dropped = 0;
      for (const entry of entries.values()) {
        if (entry.id) out.push({ id: entry.id, name: entry.name, arguments: entry.buf });
        else dropped++;
      }
      diag.droppedNoId = dropped;
      return out;
    },
    diagnostics: () => ({ ...diag }),
  };
}

/**
 * Responses：参数分片按 `item_id` 走，下一轮却按 `call_id` 引用，所以要从
 * `output_item.added` 记下映射。权威来源依次是终帧 `output[]`、`output_item.done`、
 * `function_call_arguments.done`，最后才是自己拼的分片。
 *
 * 结束帧是 `response.completed` / `response.incomplete`；`response.failed` 也算
 * 结束，但不结算任何 tool call。
 */
function createResponsesCollector(): ToolCallCollector {
  const items = new Map<string, { callId: string; name: string; buf: string; final: string | null }>();
  const settled = new Map<string, UpstreamToolCall>();
  let failed = false;
  const diag = newDiagnostics();

  return {
    observe(block) {
      const evt = parseData(block, diag);
      if (!evt || evt === "done") return false;
      switch (evt.type) {
        case "response.output_item.added": {
          const item = asRecord(evt.item);
          if (item?.type === "function_call" && typeof item.id === "string" && item.id) {
            items.set(item.id, {
              callId: typeof item.call_id === "string" ? item.call_id : "",
              name: typeof item.name === "string" ? item.name : "",
              buf: "",
              final: item.arguments !== undefined && item.arguments !== ""
                ? serializeArguments(item.arguments) || null
                : null,
            });
          }
          return false;
        }
        case "response.function_call_arguments.delta": {
          const entry = typeof evt.item_id === "string" ? items.get(evt.item_id) : undefined;
          if (entry && typeof evt.delta === "string") entry.buf += evt.delta;
          return false;
        }
        case "response.function_call_arguments.done": {
          const entry = typeof evt.item_id === "string" ? items.get(evt.item_id) : undefined;
          if (entry && evt.arguments !== undefined) entry.final = serializeArguments(evt.arguments);
          return false;
        }
        case "response.output_item.done":
          mergeResponsesToolCalls(settled, [evt.item]);
          return false;
        case "response.completed":
        case "response.incomplete":
          diag.endFrame ??= evt.type;
          mergeResponsesToolCalls(settled, asRecord(evt.response)?.output);
          return true;
        case "response.failed":
          diag.endFrame ??= evt.type;
          diag.failed = true;
          failed = true;
          return true;
        default:
          return false;
      }
    },
    calls() {
      if (failed) return [];
      const out = new Map(settled);
      let dropped = 0;
      for (const entry of items.values()) {
        if (!entry.callId) {
          dropped++;
          continue;
        }
        if (out.has(entry.callId)) continue;
        out.set(entry.callId, {
          id: entry.callId,
          name: entry.name,
          arguments: entry.final ?? entry.buf,
        });
      }
      diag.droppedNoId = dropped;
      return [...out.values()];
    },
    diagnostics: () => ({ ...diag }),
  };
}

export function createToolCallCollector(protocol: SettleCollectProtocol): ToolCallCollector {
  return protocol === "anthropic"
    ? createAnthropicCollector()
    : protocol === "responses"
      ? createResponsesCollector()
      : createChatCollector();
}

/** 非流式响应体里的 tool call。解析失败返回空数组。 */
export function collectToolCallsFromBody(
  protocol: SettleCollectProtocol,
  text: string,
): UpstreamToolCall[] {
  let body: Record<string, unknown> | null;
  try {
    body = asRecord(JSON.parse(text));
  } catch {
    return [];
  }
  if (!body) return [];

  if (protocol === "anthropic") {
    const content = body.content;
    if (!Array.isArray(content)) return [];
    const out: UpstreamToolCall[] = [];
    for (const block of content) {
      const b = asRecord(block);
      if (b?.type !== "tool_use" || typeof b.id !== "string" || !b.id) continue;
      out.push({
        id: b.id,
        name: typeof b.name === "string" ? b.name : "",
        arguments: serializeArguments(b.input),
      });
    }
    return out;
  }

  if (protocol === "openai") {
    const choices = body.choices;
    if (!Array.isArray(choices)) return [];
    const out: UpstreamToolCall[] = [];
    for (const choice of choices) {
      const toolCalls = asRecord(asRecord(choice)?.message)?.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const tc of toolCalls) {
        const t = asRecord(tc);
        if (!t || typeof t.id !== "string" || !t.id) continue;
        const fn = asRecord(t.function);
        out.push({
          id: t.id,
          name: typeof fn?.name === "string" ? fn.name : "",
          arguments: serializeArguments(fn?.arguments),
        });
      }
    }
    return out;
  }

  const output = Array.isArray(body.output) ? body.output : asRecord(body.response)?.output;
  return collectResponsesToolCalls(output);
}
