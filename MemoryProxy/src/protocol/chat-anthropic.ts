import { acknowledgeCache, checkFields, convertUsage, list, object, outputLimit, parseArguments, ProtocolError, string, unsupported, type ConversionOptions, type JsonObject } from "./common.js";

function chatContent(raw: unknown): JsonObject[] {
  if (raw == null) return [];
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  return list(raw, "content").map(value => {
    const part = object(value, "content[]");
    if (part.type === "text") return { type: "text", text: string(part.text, "text") };
    if (part.type === "image_url") {
      const image = object(part.image_url, "image_url");
      if (image.detail && image.detail !== "auto") unsupported("image_url.detail");
      const url = string(image.url, "image_url.url");
      const data = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
      if (url.startsWith("data:") && !data) throw new ProtocolError("Invalid image data URL", "image_url");
      return { type: "image", source: data ? { type: "base64", media_type: data[1], data: data[2] } : { type: "url", url } };
    }
    return unsupported(`content.${part.type}`);
  });
}

function anthropicParts(raw: unknown, options: ConversionOptions): JsonObject[] {
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  return list(raw, "content").map(value => {
    const block = object(value, "content[]");
    acknowledgeCache(block, options);
    if (block.type === "text") return { type: "text", text: string(block.text, "text") };
    if (block.type === "image") {
      const source = object(block.source, "image.source");
      const url = source.type === "url" ? string(source.url, "image.url")
        : source.type === "base64" ? `data:${string(source.media_type, "image.media_type")};base64,${string(source.data, "image.data")}`
        : unsupported("image.source.type");
      return { type: "image_url", image_url: { url } };
    }
    return unsupported(`content.${block.type}`);
  });
}

function collapse(parts: JsonObject[]): unknown {
  return parts.every(part => part.type === "text") ? parts.map(part => part.text).join("") : parts;
}

function chatAssistant(message: JsonObject): JsonObject[] {
  if (message.refusal) unsupported("assistant.refusal");
  if (message.reasoning_content || message.reasoning) unsupported("assistant.reasoning");
  const content = chatContent(message.content);
  if (content.some(part => part.type !== "text")) unsupported("assistant.image");
  for (const value of list(message.tool_calls ?? [], "tool_calls")) {
    const call = object(value, "tool_calls[]");
    if (call.type !== "function") unsupported("tool_calls.type");
    const fn = object(call.function, "tool_calls.function");
    content.push({ type: "tool_use", id: string(call.id, "tool_calls.id"), name: string(fn.name, "function.name"), input: parseArguments(fn.arguments) });
  }
  return content;
}

function anthropicAssistant(raw: unknown, options: ConversionOptions): JsonObject {
  const parts = typeof raw === "string" ? [{ type: "text", text: raw }] : list(raw, "content").map(value => object(value, "content[]"));
  const texts: JsonObject[] = [];
  const calls: JsonObject[] = [];
  for (const part of parts) {
    acknowledgeCache(part, options);
    if (part.type === "tool_use") {
      calls.push({ id: string(part.id, "tool_use.id"), type: "function", function: { name: string(part.name, "tool_use.name"), arguments: JSON.stringify(object(part.input, "tool_use.input")) } });
    } else if (part.type === "text") {
      // Chat has a separate text field, so later text cannot retain its position after a tool call.
      if (calls.length) unsupported("assistant.content order after tool_use");
      texts.push({ type: "text", text: string(part.text, "text") });
    } else unsupported(`content.${part.type}`);
  }
  return { role: "assistant", content: texts.length ? collapse(texts) : null, ...(calls.length ? { tool_calls: calls } : {}) };
}

export function chatToAnthropic(body: JsonObject, options: ConversionOptions = {}): JsonObject {
  checkFields(body, ["model", "messages", "max_tokens", "max_completion_tokens", "stream", "stream_options", "temperature", "top_p", "stop", "tools", "tool_choice", "parallel_tool_calls", "n"]);
  if (body.n != null && body.n !== 1) unsupported("n");
  if (body.max_tokens != null && body.max_completion_tokens != null && body.max_tokens !== body.max_completion_tokens) unsupported("conflicting token limits");
  const messages: JsonObject[] = [];
  const system: JsonObject[] = [];
  for (const value of list(body.messages, "messages")) {
    const message = object(value, "messages[]");
    if (message.role === "system" || message.role === "developer") {
      if (messages.length) unsupported("system/developer after conversation messages");
      const parts = chatContent(message.content);
      if (parts.some(part => part.type !== "text")) unsupported("system.image");
      system.push(...parts);
    } else if (message.role === "tool") {
      if (typeof message.content !== "string") unsupported("tool.content");
      const result = { type: "tool_result", tool_use_id: string(message.tool_call_id, "tool_call_id"), content: message.content };
      const previous = messages.at(-1);
      if (previous?.role === "user" && Array.isArray(previous.content) && previous.content.every(part => object(part).type === "tool_result")) previous.content.push(result);
      else messages.push({ role: "user", content: [result] });
    } else if (message.role === "assistant") messages.push({ role: "assistant", content: chatAssistant(message) });
    else if (message.role === "user") messages.push({ role: "user", content: chatContent(message.content) });
    else unsupported(`messages.role.${message.role}`);
  }
  const result: JsonObject = { model: string(body.model, "model"), max_tokens: outputLimit(body.max_completion_tokens ?? body.max_tokens ?? options.maxTokens), stream: body.stream === true, ...(system.length ? { system } : {}), messages };
  for (const key of ["temperature", "top_p"]) if (body[key] != null) result[key] = body[key];
  if (body.stop != null) result.stop_sequences = typeof body.stop === "string" ? [body.stop] : list(body.stop, "stop").map(value => string(value, "stop[]"));
  if (body.tools != null) result.tools = list(body.tools, "tools").map(value => {
    const tool = object(value, "tools[]");
    if (tool.type !== "function") unsupported("tools.type");
    const fn = object(tool.function, "tools.function");
    if (fn.strict === true) unsupported("tools.function.strict");
    checkFields(fn, ["name", "description", "parameters", "strict"], "tools.function");
    return { name: string(fn.name, "tools.name"), ...(fn.description != null ? { description: string(fn.description, "tools.description") } : {}), input_schema: object(fn.parameters ?? { type: "object", properties: {} }, "tools.parameters") };
  });
  if (body.tool_choice != null || body.parallel_tool_calls === false) {
    const choice = body.tool_choice ?? "auto";
    const mapped = typeof choice === "string"
      ? { type: choice === "required" ? "any" : ["auto", "none"].includes(choice) ? choice : unsupported("tool_choice") }
      : { type: "tool", name: string(object(object(choice).function, "tool_choice.function").name, "tool_choice.name") };
    result.tool_choice = { ...mapped, ...(body.parallel_tool_calls === false && mapped.type !== "none" ? { disable_parallel_tool_use: true } : {}) };
  }
  return result;
}

export function anthropicToChat(body: JsonObject, options: ConversionOptions = {}): JsonObject {
  checkFields(body, ["model", "messages", "system", "max_tokens", "stream", "temperature", "top_p", "stop_sequences", "tools", "tool_choice"]);
  const messages: JsonObject[] = [];
  if (body.system != null) {
    const system = anthropicParts(body.system, options);
    if (system.some(part => part.type !== "text")) unsupported("system.image");
    messages.push({ role: "system", content: collapse(system) });
  }
  for (const value of list(body.messages, "messages")) {
    const message = object(value, "messages[]");
    if (message.role === "assistant") { messages.push(anthropicAssistant(message.content, options)); continue; }
    if (message.role !== "user") unsupported(`messages.role.${message.role}`);
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : list(message.content, "content");
    let pending: unknown[] = [];
    const flush = () => { if (pending.length) { messages.push({ role: "user", content: collapse(anthropicParts(pending, options)) }); pending = []; } };
    for (const raw of content) {
      const part = object(raw, "content[]");
      if (part.type !== "tool_result") { pending.push(part); continue; }
      flush(); acknowledgeCache(part, options);
      if (part.is_error === true) unsupported("tool_result.is_error");
      const result = typeof part.content === "string" ? part.content : collapse(anthropicParts(part.content ?? [], options));
      if (typeof result !== "string") unsupported("tool_result.image");
      messages.push({ role: "tool", tool_call_id: string(part.tool_use_id, "tool_result.tool_use_id"), content: result });
    }
    flush();
  }
  const result: JsonObject = { model: string(body.model, "model"), messages, stream: body.stream === true };
  if (body.max_tokens != null) result.max_tokens = outputLimit(body.max_tokens);
  for (const key of ["temperature", "top_p"]) if (body[key] != null) result[key] = body[key];
  if (body.stop_sequences != null) result.stop = body.stop_sequences;
  if (body.tools != null) result.tools = list(body.tools, "tools").map(value => {
    const tool = object(value, "tools[]");
    acknowledgeCache(tool, options);
    checkFields(tool, ["name", "description", "input_schema", "cache_control"], "tools");
    return { type: "function", function: { name: string(tool.name, "tools.name"), ...(tool.description != null ? { description: tool.description } : {}), parameters: object(tool.input_schema, "tools.input_schema") } };
  });
  if (body.tool_choice != null) {
    const choice = object(body.tool_choice, "tool_choice");
    result.tool_choice = choice.type === "any" ? "required" : choice.type === "tool" ? { type: "function", function: { name: string(choice.name, "tool_choice.name") } }
      : choice.type === "auto" || choice.type === "none" ? choice.type : unsupported("tool_choice.type");
    if (choice.disable_parallel_tool_use === true) result.parallel_tool_calls = false;
  }
  return result;
}

export function chatJsonToAnthropic(body: JsonObject): JsonObject {
  const choices = list(body.choices, "choices");
  if (choices.length !== 1) unsupported("choices (exactly one required)");
  const choice = object(choices[0], "choices[0]");
  const reason = choice.finish_reason === "stop" ? "end_turn" : choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "tool_calls" ? "tool_use" : unsupported(`finish_reason.${choice.finish_reason}`);
  const usage = convertUsage(body.usage, "chat", "anthropic");
  return { id: string(body.id, "id"), type: "message", role: "assistant", model: string(body.model, "model"), content: chatAssistant(object(choice.message, "message")), stop_reason: reason, stop_sequence: null, ...(usage ? { usage } : {}) };
}

export function anthropicJsonToChat(body: JsonObject): JsonObject {
  const reason = body.stop_reason === "end_turn" || body.stop_reason === "stop_sequence" ? "stop" : body.stop_reason === "max_tokens" || body.stop_reason === "model_context_window_exceeded" ? "length" : body.stop_reason === "tool_use" ? "tool_calls" : unsupported(`stop_reason.${body.stop_reason}`);
  const usage = convertUsage(body.usage, "anthropic", "chat");
  return { id: string(body.id, "id"), object: "chat.completion", created: Math.floor(Date.now() / 1000), model: string(body.model, "model"), choices: [{ index: 0, message: anthropicAssistant(body.content, {}), finish_reason: reason }], ...(usage ? { usage } : {}) };
}
