import { acknowledgeCache, checkFields, convertUsage, list, object, outputLimit, parseArguments, ProtocolError, string, unsupported, type ConversionOptions, type JsonObject } from "./common.js";

function toAnthropicContent(raw: unknown): JsonObject[] {
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  return list(raw, "content").map(value => {
    const part = object(value, "content[]");
    if (part.type === "input_text" || part.type === "output_text") {
      if (Array.isArray(part.annotations) && part.annotations.length) unsupported("content.annotations");
      return { type: "text", text: string(part.text, "content.text") };
    }
    if (part.type === "input_image") {
      if (part.file_id != null) unsupported("input_image.file_id");
      if (part.detail && part.detail !== "auto") unsupported("input_image.detail");
      const url = string(part.image_url, "input_image.image_url");
      const data = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
      if (url.startsWith("data:") && !data) throw new ProtocolError("Invalid image data URL", "input_image");
      return { type: "image", source: data ? { type: "base64", media_type: data[1], data: data[2] } : { type: "url", url } };
    }
    return unsupported(`content.${part.type}`);
  });
}

function toResponsesContent(raw: unknown, assistant: boolean, options: ConversionOptions): JsonObject[] {
  const content = typeof raw === "string" ? [{ type: "text", text: raw }] : list(raw, "content");
  return content.map(value => {
    const block = object(value, "content[]");
    acknowledgeCache(block, options);
    if (block.type === "text") {
      if (Array.isArray(block.citations) && block.citations.length) unsupported("content.citations");
      return { type: assistant ? "output_text" : "input_text", text: string(block.text, "text"), ...(assistant ? { annotations: [] } : {}) };
    }
    if (block.type === "image" && !assistant) {
      const source = object(block.source, "image.source");
      const url = source.type === "url" ? string(source.url, "image.url")
        : source.type === "base64" ? `data:${string(source.media_type, "image.media_type")};base64,${string(source.data, "image.data")}` : unsupported("image.source");
      return { type: "input_image", image_url: url };
    }
    return unsupported(`content.${block.type}`);
  });
}

export function responsesToAnthropic(body: JsonObject, options: ConversionOptions = {}): JsonObject {
  checkFields(body, ["model", "input", "instructions", "max_output_tokens", "stream", "temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls", "store", "background"]);
  if (body.background === true) unsupported("background");
  if (body.store === true) unsupported("store");
  const system: JsonObject[] = body.instructions == null ? [] : [{ type: "text", text: string(body.instructions, "instructions") }];
  const messages: JsonObject[] = [];
  function append(role: string, content: JsonObject[]) {
    const last = messages.at(-1);
    if (last?.role === role) (last.content as JsonObject[]).push(...content);
    else messages.push({ role, content });
  }
  const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : list(body.input, "input");
  for (const value of input) {
    const item = object(value, "input[]");
    if (item.type === "function_call") {
      append("assistant", [{ type: "tool_use", id: string(item.call_id, "call_id"), name: string(item.name, "name"), input: parseArguments(item.arguments) }]);
    } else if (item.type === "function_call_output") {
      append("user", [{ type: "tool_result", tool_use_id: string(item.call_id, "call_id"), content: typeof item.output === "string" ? item.output : toAnthropicContent(item.output) }]);
    } else if (item.type === "message" || item.type === undefined) {
      const content = toAnthropicContent(item.content);
      if (item.role === "system" || item.role === "developer") {
        if (messages.length) unsupported("system/developer after conversation messages");
        if (content.some(block => block.type !== "text")) unsupported("system.image");
        system.push(...content);
      } else if (item.role === "user" || item.role === "assistant") {
        if (item.role === "assistant" && content.some(block => block.type !== "text")) unsupported("assistant.image");
        append(item.role, content);
      } else unsupported(`input.role.${item.role}`);
    } else unsupported(`input.${item.type}`);
  }
  const result: JsonObject = { model: string(body.model, "model"), max_tokens: outputLimit(body.max_output_tokens ?? options.maxTokens), stream: body.stream === true, ...(system.length ? { system } : {}), messages };
  for (const key of ["temperature", "top_p"]) if (body[key] != null) result[key] = body[key];
  if (body.tools != null) result.tools = list(body.tools, "tools").map(value => {
    const tool = object(value, "tools[]");
    if (tool.type !== "function") unsupported(`tools.${tool.type}`);
    if (tool.strict === true) unsupported("tools.strict");
    checkFields(tool, ["type", "name", "description", "parameters", "strict"], "tools");
    return { name: string(tool.name, "tools.name"), ...(tool.description != null ? { description: tool.description } : {}), input_schema: object(tool.parameters ?? { type: "object", properties: {} }, "tools.parameters") };
  });
  if (body.tool_choice != null || body.parallel_tool_calls === false) {
    const choice = body.tool_choice ?? "auto";
    const mapped = typeof choice === "string" ? { type: choice === "required" ? "any" : ["auto", "none"].includes(choice) ? choice : unsupported("tool_choice") }
      : object(choice).type === "function" ? { type: "tool", name: string(object(choice).name, "tool_choice.name") } : unsupported("tool_choice.type");
    result.tool_choice = { ...mapped, ...(body.parallel_tool_calls === false && mapped.type !== "none" ? { disable_parallel_tool_use: true } : {}) };
  }
  return result;
}

/** Direct ordered item conversion: no Chat tool-message/text projection. */
export function anthropicToResponses(body: JsonObject, options: ConversionOptions = {}): JsonObject {
  checkFields(body, ["model", "messages", "system", "max_tokens", "stream", "temperature", "top_p", "tools", "tool_choice"]);
  const input: JsonObject[] = [];
  if (body.system != null) input.push({ type: "message", role: "system", content: toResponsesContent(body.system, false, options) });
  for (const value of list(body.messages, "messages")) {
    const message = object(value, "messages[]");
    if (message.role !== "user" && message.role !== "assistant") unsupported(`messages.role.${message.role}`);
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : list(message.content, "content");
    let pending: unknown[] = [];
    const flush = () => { if (pending.length) { input.push({ type: "message", role: message.role, content: toResponsesContent(pending, message.role === "assistant", options) }); pending = []; } };
    for (const raw of content) {
      const block = object(raw, "content[]");
      if (block.type !== "tool_use" && block.type !== "tool_result") { pending.push(block); continue; }
      flush(); acknowledgeCache(block, options);
      if (block.type === "tool_use") {
        if (message.role !== "assistant") unsupported("user.tool_use");
        input.push({ type: "function_call", call_id: string(block.id, "tool_use.id"), name: string(block.name, "tool_use.name"), arguments: JSON.stringify(object(block.input, "tool_use.input")) });
      } else {
        if (message.role !== "user") unsupported("assistant.tool_result");
        if (block.is_error === true) unsupported("tool_result.is_error");
        input.push({ type: "function_call_output", call_id: string(block.tool_use_id, "tool_result.tool_use_id"), output: typeof block.content === "string" ? block.content : toResponsesContent(block.content ?? [], false, options) });
      }
    }
    flush();
  }
  const result: JsonObject = { model: string(body.model, "model"), input, stream: body.stream === true, store: false };
  if (body.max_tokens != null) result.max_output_tokens = outputLimit(body.max_tokens);
  for (const key of ["temperature", "top_p"]) if (body[key] != null) result[key] = body[key];
  if (body.tools != null) result.tools = list(body.tools, "tools").map(value => {
    const tool = object(value, "tools[]");
    acknowledgeCache(tool, options);
    checkFields(tool, ["name", "description", "input_schema", "cache_control"], "tools");
    return { type: "function", name: string(tool.name, "tools.name"), ...(tool.description != null ? { description: tool.description } : {}), parameters: object(tool.input_schema, "tools.input_schema") };
  });
  if (body.tool_choice != null) {
    const choice = object(body.tool_choice, "tool_choice");
    result.tool_choice = choice.type === "any" ? "required" : choice.type === "tool" ? { type: "function", name: string(choice.name, "tool_choice.name") } : choice.type === "auto" || choice.type === "none" ? choice.type : unsupported("tool_choice.type");
    if (choice.disable_parallel_tool_use === true) result.parallel_tool_calls = false;
  }
  return result;
}

export function anthropicJsonToResponses(body: JsonObject, request: JsonObject = {}): JsonObject {
  const truncated = body.stop_reason === "max_tokens" || body.stop_reason === "model_context_window_exceeded";
  if (!truncated && !["end_turn", "stop_sequence", "tool_use"].includes(String(body.stop_reason))) unsupported(`stop_reason.${body.stop_reason}`);
  const id = string(body.id, "id");
  const output: JsonObject[] = list(body.content, "content").map((value, index) => {
    const block = object(value, "content[]");
    if (block.type === "tool_use") return { type: "function_call", id: `fc_${id}_${index}`, call_id: string(block.id, "tool_use.id"), name: string(block.name, "tool_use.name"), arguments: JSON.stringify(object(block.input, "tool_use.input")), status: truncated ? "incomplete" : "completed" };
    return { type: "message", id: `msg_${id}_${index}`, role: "assistant", content: toResponsesContent([block], true, {}), status: truncated ? "incomplete" : "completed" };
  });
  const usage = convertUsage(body.usage, "anthropic", "responses");
  return { id, object: "response", created_at: Math.floor(Date.now() / 1000), status: truncated ? "incomplete" : "completed", error: null, incomplete_details: truncated ? { reason: "max_output_tokens" } : null, model: string(body.model, "model"), output,
    instructions: request.instructions ?? null, max_output_tokens: request.max_output_tokens ?? null,
    parallel_tool_calls: request.parallel_tool_calls ?? true, tool_choice: request.tool_choice ?? "auto", tools: request.tools ?? [],
    temperature: request.temperature ?? null, top_p: request.top_p ?? null,
    previous_response_id: null, store: false, metadata: {}, ...(usage ? { usage } : {}),
  };
}

export function responsesJsonToAnthropic(body: JsonObject): JsonObject {
  if (body.status === "failed") throw new ProtocolError(String(object(body.error ?? {}).message ?? "Upstream response failed"), undefined, 502);
  if (body.status !== "completed" && body.status !== "incomplete") unsupported(`status.${body.status}`);
  const content: JsonObject[] = [];
  for (const value of list(body.output, "output")) {
    const item = object(value, "output[]");
    if (item.type === "function_call") content.push({ type: "tool_use", id: string(item.call_id, "call_id"), name: string(item.name, "name"), input: parseArguments(item.arguments) });
    else if (item.type === "message") {
      if (item.role !== "assistant") unsupported(`output.role.${item.role}`);
      content.push(...toAnthropicContent(item.content));
    } else unsupported(`output.${item.type}`);
  }
  const incomplete = body.status === "incomplete";
  const reason = incomplete ? object(body.incomplete_details, "incomplete_details").reason : undefined;
  if (incomplete && reason !== "max_output_tokens") unsupported(`incomplete_details.${reason}`);
  const usage = convertUsage(body.usage, "responses", "anthropic");
  return { id: string(body.id, "id"), type: "message", role: "assistant", model: string(body.model, "model"), content, stop_reason: incomplete ? "max_tokens" : content.some(part => part.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, ...(usage ? { usage } : {}) };
}
