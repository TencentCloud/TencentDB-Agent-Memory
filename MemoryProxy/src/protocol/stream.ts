import { convertUsage, createSseDecoder, list, object, parseArguments, ProtocolError, sseFrame, string, unsupported, type JsonObject, type SseFrame, type WireProtocol } from "./common.js";

interface Item {
  kind: "text" | "tool";
  index: number;
  toolIndex: number;
  id: string;
  name: string;
  text: string;
  closed: boolean;
}
export interface StreamOptions {
  request?: JsonObject;
  /** Cumulative, raw upstream usage. Never account against the converted schema. */
  onUsage?: (usage: JsonObject) => void;
  maxOutputChars?: number;
}

/** Ordered content events are mapped directly, without a Chat-message intermediate. */
export function convertSse(source: ReadableStream<Uint8Array>, from: WireProtocol, to: WireProtocol, options: StreamOptions = {}): ReadableStream<Uint8Array> {
  if (from === to) return source;
  let id = "";
  let model = "";
  let started = false;
  let ended = false;
  let reason: string | undefined;
  let rawUsage: JsonObject | undefined;
  let sequence = 0;
  let totalChars = 0;
  const created = Math.floor(Date.now() / 1000);
  const items: Item[] = [];
  const bySource = new Map<string, Item>();
  const responseMessageIds = new Map<number, string>();
  let controller: TransformStreamDefaultController<Uint8Array>;

  function emit(event: string | undefined, value: JsonObject | string) {
    const data = to === "responses" && typeof value !== "string" ? { ...value, sequence_number: sequence++ } : value;
    controller.enqueue(sseFrame(event, data));
  }
  function chat(delta: JsonObject, finish: string | null = null) {
    emit(undefined, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
  }
  function snapshot(status: string, error: JsonObject | null = null): JsonObject {
    const output = items.map(item => item.kind === "text"
      ? { type: "message", id: item.id, role: "assistant", content: [{ type: "output_text", text: item.text, annotations: [] }], status: status === "incomplete" ? "incomplete" : item.closed ? "completed" : "in_progress" }
      : { type: "function_call", id: `fc_${item.index}_${id}`, call_id: item.id, name: item.name, arguments: item.text, status: status === "incomplete" ? "incomplete" : item.closed ? "completed" : "in_progress" });
    return { id, object: "response", created_at: created, model, status, output, error,
      incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
      usage: convertUsage(rawUsage, from, "responses") ?? null,
      instructions: options.request?.instructions ?? null, tools: options.request?.tools ?? [],
      tool_choice: options.request?.tool_choice ?? "auto", parallel_tool_calls: options.request?.parallel_tool_calls ?? true,
      max_output_tokens: options.request?.max_output_tokens ?? null, store: false, previous_response_id: null, metadata: {},
    };
  }
  function fail(message: string) {
    if (ended) return;
    if (to === "anthropic") emit("error", { type: "error", error: { type: "api_error", message } });
    else if (to === "chat") emit(undefined, { error: { message, type: "server_error", code: "protocol_conversion_error" } });
    else emit("response.failed", { type: "response.failed", response: snapshot("failed", { code: "server_error", message }) });
    ended = true;
    controller.terminate();
  }
  function usage(value: unknown) {
    if (value == null) return;
    rawUsage = { ...rawUsage, ...object(value, "usage") };
    // Validate even when the caller does not request usage in client-facing events.
    convertUsage(rawUsage, from, to);
    options.onUsage?.(structuredClone(rawUsage));
  }
  function start(sourceId: unknown, sourceModel: unknown) {
    if (started) return;
    id = string(sourceId, "stream.id"); model = string(sourceModel, "stream.model"); started = true;
    if (to === "anthropic") emit("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null,
      // Messages requires initial counters; later cumulative snapshots replace these.
      usage: { input_tokens: 0, output_tokens: 0, ...convertUsage(rawUsage, from, "anthropic") },
    } });
    else if (to === "chat") chat({ role: "assistant", content: "" });
    else emit("response.created", { type: "response.created", response: snapshot("in_progress") });
  }
  function get(key: string): Item {
    const item = bySource.get(key);
    if (!item) throw new ProtocolError(`Delta for unknown content item ${key}`, undefined, 502);
    return item;
  }
  function add(key: string, kind: Item["kind"], callId = "", name = ""): Item {
    if (!started || bySource.has(key)) throw new ProtocolError("Invalid stream content start", undefined, 502);
    const item: Item = { kind, index: items.length, toolIndex: items.filter(item => item.kind === "tool").length, id: kind === "tool" ? callId : `msg_${id}_${items.length}`, name, text: "", closed: false };
    if (kind === "tool" && (!callId || !name)) throw new ProtocolError("Tool stream requires a complete call ID and name before arguments", undefined, 502);
    bySource.set(key, item); items.push(item);
    if (to === "anthropic") emit("content_block_start", { type: "content_block_start", index: item.index, content_block: kind === "text" ? { type: "text", text: "" } : { type: "tool_use", id: item.id, name, input: {} } });
    else if (to === "chat" && kind === "tool") chat({ tool_calls: [{ index: item.toolIndex, id: item.id, type: "function", function: { name, arguments: "" } }] });
    else if (to === "responses") {
      const output = (snapshot("in_progress").output as JsonObject[])[item.index];
      emit("response.output_item.added", { type: "response.output_item.added", output_index: item.index, item: kind === "text" ? { ...output, content: [] } : output });
      if (kind === "text") emit("response.content_part.added", { type: "response.content_part.added", item_id: item.id, output_index: item.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    }
    return item;
  }
  function delta(item: Item, value: unknown) {
    const text = string(value, "stream.delta");
    if (item.closed) throw new ProtocolError("Delta received after content end", undefined, 502);
    totalChars += text.length;
    // Responses terminal events contain full output: retain it with an explicit ceiling.
    if (totalChars > (options.maxOutputChars ?? 16 * 1024 * 1024)) throw new ProtocolError("Converted stream output exceeds limit", undefined, 502);
    item.text += text;
    if (to === "anthropic") emit("content_block_delta", { type: "content_block_delta", index: item.index, delta: item.kind === "text" ? { type: "text_delta", text } : { type: "input_json_delta", partial_json: text } });
    else if (to === "chat") chat(item.kind === "text" ? { content: text } : { tool_calls: [{ index: item.toolIndex, function: { arguments: text } }] });
    else {
      const type = item.kind === "text" ? "response.output_text.delta" : "response.function_call_arguments.delta";
      emit(type, { type, item_id: item.kind === "text" ? item.id : `fc_${item.index}_${id}`, output_index: item.index, ...(item.kind === "text" ? { content_index: 0, logprobs: [] } : {}), delta: text });
    }
  }
  function close(item: Item) {
    if (item.closed) return;
    item.closed = true;
    if (to === "anthropic") emit("content_block_stop", { type: "content_block_stop", index: item.index });
    else if (to === "responses") {
      if (item.kind === "text") {
        emit("response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: item.index, content_index: 0, text: item.text, logprobs: [] });
        emit("response.content_part.done", { type: "response.content_part.done", item_id: item.id, output_index: item.index, content_index: 0, part: { type: "output_text", text: item.text, annotations: [] } });
      } else emit("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: `fc_${item.index}_${id}`, output_index: item.index, name: item.name, arguments: item.text });
    }
  }
  function finish() {
    if (ended) return;
    if (!started || !reason) throw new ProtocolError("Upstream stream ended without a model terminal event", undefined, 502);
    if (!["end_turn", "stop_sequence", "tool_use", "max_tokens", "model_context_window_exceeded"].includes(reason)) unsupported(`stream.stop_reason.${reason}`);
    const incomplete = reason === "max_tokens" || reason === "model_context_window_exceeded";
    for (const item of items) {
      if (item.kind === "tool" && !incomplete) parseArguments(item.text || "{}");
      close(item);
    }
    const converted = convertUsage(rawUsage, from, to);
    if (to === "anthropic") {
      emit("message_delta", { type: "message_delta", delta: { stop_reason: incomplete ? "max_tokens" : reason, stop_sequence: null }, usage: { output_tokens: 0, ...converted } });
      emit("message_stop", { type: "message_stop" });
    } else if (to === "chat") {
      chat({}, incomplete ? "length" : reason === "tool_use" ? "tool_calls" : "stop");
      if (converted) emit(undefined, { id, object: "chat.completion.chunk", created, model, choices: [], usage: converted });
      emit(undefined, "[DONE]");
    } else {
      const response = snapshot(incomplete ? "incomplete" : "completed");
      for (const item of items) emit("response.output_item.done", { type: "response.output_item.done", output_index: item.index, item: (response.output as JsonObject[])[item.index] });
      const type = incomplete ? "response.incomplete" : "response.completed";
      emit(type, { type, response });
    }
    ended = true;
  }
  function readChat(data: JsonObject) {
    if (data.error) { fail(String(object(data.error).message ?? "Upstream error")); return; }
    usage(data.usage);
    start(data.id, data.model);
    const choices = list(data.choices, "choices");
    if (choices.length > 1) unsupported("stream.choices");
    for (const value of choices) {
      const choice = object(value, "choice");
      if (choice.index !== 0) unsupported("stream.choice.index");
      const part = object(choice.delta ?? {}, "delta");
      if (part.refusal || part.reasoning_content) unsupported("stream.reasoning/refusal");
      if (part.content != null && part.content !== "") {
        const key = `text:${items.filter(item => item.kind === "tool").length}`;
        delta(bySource.get(key) ?? add(key, "text"), part.content);
      }
      for (const value of list(part.tool_calls ?? [], "delta.tool_calls")) {
        const call = object(value, "tool_call");
        if (!Number.isInteger(call.index)) unsupported("tool_call.index");
        const key = `tool:${call.index}`;
        const fn = object(call.function ?? {}, "tool_call.function");
        let item = bySource.get(key);
        if (!item) item = add(key, "tool", string(call.id, "tool_call.id"), string(fn.name, "function.name"));
        else if ((call.id != null && call.id !== item.id) || (fn.name != null && fn.name !== item.name)) unsupported("fragmented tool name/id after start");
        if (fn.arguments != null && fn.arguments !== "") delta(item, fn.arguments);
      }
      if (choice.finish_reason != null) reason = choice.finish_reason === "stop" ? "end_turn" : choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "tool_calls" ? "tool_use" : String(choice.finish_reason);
    }
  }
  function readAnthropic(data: JsonObject) {
    const type = data.type;
    if (type === "ping") return;
    if (type === "error") { fail(String(object(data.error).message ?? "Upstream error")); return; }
    if (type === "message_start") {
      const message = object(data.message, "message"); usage(message.usage); start(message.id, message.model); return;
    }
    if (type === "content_block_start") {
      const block = object(data.content_block, "content_block");
      if (block.type !== "text" && block.type !== "tool_use") unsupported(`stream.${block.type}`);
      const item = add(String(data.index), block.type === "text" ? "text" : "tool", block.type === "tool_use" ? string(block.id, "tool_use.id") : "", block.type === "tool_use" ? string(block.name, "tool_use.name") : "");
      if (block.type === "text" && block.text) delta(item, block.text);
      if (block.type === "tool_use" && Object.keys(object(block.input ?? {}, "tool_use.input")).length) delta(item, JSON.stringify(block.input));
      return;
    }
    if (type === "content_block_delta") {
      const part = object(data.delta, "delta");
      if (part.type !== "text_delta" && part.type !== "input_json_delta") unsupported(`stream.${part.type}`);
      const item = get(String(data.index));
      if ((item.kind === "text") !== (part.type === "text_delta")) throw new ProtocolError("Mismatched content delta type", undefined, 502);
      delta(item, part.type === "text_delta" ? part.text : part.partial_json); return;
    }
    if (type === "content_block_stop") { close(get(String(data.index))); return; }
    if (type === "message_delta") { usage(data.usage); reason = string(object(data.delta).stop_reason, "stop_reason"); return; }
    if (type === "message_stop") { finish(); return; }
    unsupported(`stream.event.${type}`);
  }
  function readResponses(data: JsonObject) {
    const type = String(data.type);
    if (type === "response.failed" || type === "error") {
      const error = type === "response.failed" ? object(object(data.response, "response").error, "response.error") : data;
      fail(String(error.message ?? "Upstream response failed")); return;
    }
    if (type === "response.created") { const response = object(data.response); start(response.id, response.model); usage(response.usage); return; }
    if (type === "response.in_progress") return;
    const index = data.output_index;
    if (type === "response.output_item.added") {
      const item = object(data.item, "item");
      if (item.type === "message" && item.role === "assistant") responseMessageIds.set(Number(index), string(item.id, "item.id"));
      else if (item.type === "function_call") {
        const added = add(`tool:${index}`, "tool", string(item.call_id, "call_id"), string(item.name, "name"));
        if (item.arguments) delta(added, item.arguments);
      } else unsupported(`stream.output.${item.type}`);
      return;
    }
    if (type === "response.content_part.added") {
      if (!responseMessageIds.has(Number(index))) throw new ProtocolError("Content part without output message", undefined, 502);
      const part = object(data.part, "part");
      if (part.type !== "output_text") unsupported(`stream.part.${part.type}`);
      const item = add(`text:${index}:${data.content_index}`, "text");
      if (part.text) delta(item, part.text); return;
    }
    if (type === "response.output_text.delta") { delta(get(`text:${index}:${data.content_index}`), data.delta); return; }
    if (type === "response.function_call_arguments.delta") { delta(get(`tool:${index}`), data.delta); return; }
    if (type === "response.output_text.done" || type === "response.function_call_arguments.done") {
      const item = get(type === "response.output_text.done" ? `text:${index}:${data.content_index}` : `tool:${index}`);
      if (item.text !== (type === "response.output_text.done" ? data.text : data.arguments)) throw new ProtocolError("Terminal content differs from streamed deltas", undefined, 502);
      close(item); return;
    }
    if (type === "response.content_part.done" || type === "response.output_item.done") return;
    if (type === "response.completed" || type === "response.incomplete") {
      const response = object(data.response, "response"); usage(response.usage);
      if (type === "response.incomplete") {
        if (object(response.incomplete_details).reason !== "max_output_tokens") unsupported("response.incomplete reason");
        reason = "max_tokens";
      } else reason = items.some(item => item.kind === "tool") ? "tool_use" : "end_turn";
      finish(); return;
    }
    unsupported(`stream.event.${type}`);
  }
  const mapper = new TransformStream<SseFrame, Uint8Array>({
    transform(frame, target) {
      controller = target;
      if (ended) return;
      try {
        if (frame.data === "[DONE]") {
          if (from !== "chat") throw new ProtocolError("Unexpected DONE marker", undefined, 502);
          finish(); return;
        }
        const data = object(JSON.parse(frame.data), "SSE data");
        if (from === "chat") readChat(data);
        else if (from === "anthropic") readAnthropic(data);
        else readResponses(data);
      } catch (error) { fail(error instanceof Error ? error.message : "Invalid upstream stream"); }
    },
    flush(target) {
      controller = target;
      if (ended) return;
      try {
        if (from === "chat" && reason) finish();
        else fail("Upstream stream ended without a model terminal event");
      } catch (error) { fail(error instanceof Error ? error.message : "Invalid upstream stream"); }
    },
  });
  return source.pipeThrough(createSseDecoder()).pipeThrough(mapper);
}
