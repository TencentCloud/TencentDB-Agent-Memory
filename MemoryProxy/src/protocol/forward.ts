import { anthropicToChat, chatToAnthropic, anthropicJsonToChat, chatJsonToAnthropic } from "./chat-anthropic.js";
import { anthropicToResponses, responsesToAnthropic, anthropicJsonToResponses, responsesJsonToAnthropic } from "./responses-anthropic.js";
import { convertSse, type StreamOptions } from "./stream.js";
import { object, ProtocolError, unsupported, type ConversionOptions, type JsonObject, type WireProtocol } from "./common.js";
import type { UpstreamProtocolOptions } from "../types.js";

export interface ForwardProtocolContext {
  source: WireProtocol;
  settings: UpstreamProtocolOptions;
  defaultUrl: string;
  request: JsonObject;
  signal?: AbortSignal;
  warn: (message: string) => void;
  actual?: { protocol: WireProtocol; url: string; model: string; converted: boolean; usage?: JsonObject };
}

export function upstreamAccounting(context: ForwardProtocolContext | undefined, clientUsage: JsonObject | null | undefined, model: string, url: string, protocol: WireProtocol) {
  const actual = context?.actual;
  return { usage: actual?.converted ? actual.usage ?? null : clientUsage ?? null,
    model: actual?.model ?? model, url: actual?.url ?? url, protocol: actual?.protocol ?? protocol };
}

/** One actual attempt. Retry callers use the same unconverted request with a new target. */
export async function fetchProtocolAttempt(
  target: { url: string; model: string; wireProtocol?: WireProtocol; authHeaders?: Record<string, string> | null; bodyOverrides?: JsonObject | null },
  init: RequestInit,
  context?: ForwardProtocolContext,
): Promise<Response> {
  if (!context) return fetch(target.url, init);
  if (context.settings.protocol && !target.wireProtocol && target.url !== context.defaultUrl) {
    throw new ProtocolError("A dynamically selected route must declare wireProtocol when protocol conversion is configured", "upstream.protocol");
  }
  const protocol = target.wireProtocol ?? context.settings.protocol ?? context.source;
  if (!["chat", "anthropic", "responses"].includes(protocol)) throw new ProtocolError("Unknown route wireProtocol", "wireProtocol");
  const converted = protocol !== context.source;
  let url = target.url;
  let headers = new Headers(init.headers);
  let body = init.body;
  if (converted) {
    const prepared = prepareProtocolRequest({
      from: context.source, to: protocol, url, headers,
      body: { ...context.request, model: target.model }, authHeaders: target.authHeaders,
      options: { maxTokens: context.settings.maxTokens, ...(context.settings.allowCacheControlDrop ? { onWarning: context.warn } : {}) },
    });
    const overrides = target.bodyOverrides ?? {};
    for (const key of ["messages", "input", "system", "tools", "tool_choice", "stream"]) {
      if (key in overrides) throw new ProtocolError(`Cross-protocol route cannot override structural field ${key}`, `bodyOverrides.${key}`);
    }
    const outbound: JsonObject = { ...prepared.body, ...overrides, model: target.model };
    if (protocol === "chat" && outbound.stream === true) outbound.stream_options = { include_usage: true };
    url = prepared.url; headers = prepared.headers; body = JSON.stringify(outbound);
  } else if (target.authHeaders) {
    const auth = new Headers(target.authHeaders);
    if (auth.has("authorization") || auth.has("x-api-key")) { headers.delete("authorization"); headers.delete("x-api-key"); }
    auth.forEach((value, key) => headers.set(key, value));
  }
  const actual: NonNullable<ForwardProtocolContext["actual"]> = { protocol, url, model: target.model, converted };
  context.actual = actual;
  const signals = [context.signal, init.signal].filter((value): value is AbortSignal => value != null);
  const response = await fetch(url, { ...init, headers, body, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
  return convertProtocolResponse(response, protocol, context.source, context.request, { onUsage: value => { actual.usage = value; } });
}

export interface ProtocolRequest {
  body: JsonObject;
  url: string;
  headers: HeadersInit;
  from: WireProtocol;
  to: WireProtocol;
  /** Explicit destination credentials from the selected route, when present. */
  authHeaders?: Record<string, string> | null;
  options?: ConversionOptions;
}

export function prepareProtocolRequest(request: ProtocolRequest): { url: string; headers: Headers; body: JsonObject } {
  const { from, to, body, options } = request;
  const headers = new Headers(request.headers);
  if (from === to) return { url: request.url, headers, body };
  const endpoint = { chat: "/chat/completions", anthropic: "/messages", responses: "/responses" };
  const url = new URL(request.url);
  const suffix = /\/(chat\/completions|messages|responses)$/.exec(url.pathname);
  if (!suffix) throw new ProtocolError("This endpoint does not support inference protocol conversion", "endpoint");
  url.pathname = url.pathname.slice(0, -suffix[0].length) + endpoint[to];
  const converted = from === "chat" && to === "anthropic" ? chatToAnthropic(body, options)
    : from === "anthropic" && to === "chat" ? anthropicToChat(body, options)
    : from === "responses" && to === "anthropic" ? responsesToAnthropic(body, options)
    : from === "anthropic" && to === "responses" ? anthropicToResponses(body, options)
    : unsupported(`${from} → ${to}`);
  const bearer = headers.get("authorization");
  const key = from === "anthropic" ? headers.get("x-api-key") ?? bearer?.replace(/^Bearer\s+/i, "")
    : bearer?.replace(/^Bearer\s+/i, "") ?? headers.get("x-api-key");
  for (const name of ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "openai-beta", "content-length", "content-encoding", "host"]) headers.delete(name);
  if (key) headers.set(to === "anthropic" ? "x-api-key" : "authorization", to === "anthropic" ? key : `Bearer ${key}`);
  if (request.authHeaders) {
    const explicit = new Headers(request.authHeaders);
    if (explicit.has("authorization") || explicit.has("x-api-key")) {
      headers.delete("authorization"); headers.delete("x-api-key");
    }
    explicit.forEach((value, name) => headers.set(name, value));
  }
  if (to === "anthropic" && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  headers.set("content-type", "application/json");
  return { url: url.toString(), headers, body: converted };
}

function responseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of ["content-length", "content-encoding", "transfer-encoding", "connection", "etag", "digest", "content-md5"]) headers.delete(name);
  return headers;
}

export function protocolErrorResponse(error: unknown, protocol: WireProtocol, status = 400, originalHeaders?: Headers): Response {
  const message = error instanceof Error ? error.message : String(error);
  const headers = responseHeaders(originalHeaders ?? new Headers());
  headers.set("content-type", "application/json");
  const type = status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : status >= 500 ? "api_error" : "invalid_request_error";
  const body = protocol === "anthropic" ? { type: "error", error: { type, message } }
    : { error: { message, type: status >= 500 ? "server_error" : type, code: "protocol_conversion_error", param: error instanceof ProtocolError ? error.param ?? null : null } };
  return new Response(JSON.stringify(body), { status, headers });
}

/** Convert only after routing/retry has selected the actual upstream response. */
export async function convertProtocolResponse(response: Response, from: WireProtocol, to: WireProtocol, request: JsonObject, options: StreamOptions = {}): Promise<Response> {
  if (from === to) return response;
  if (!response.ok) {
    let message = `Upstream HTTP ${response.status}`;
    try {
      const raw = object(await response.json());
      const error = raw.error;
      message = typeof error === "string" ? error : error && typeof error === "object" ? String(object(error).message ?? message) : typeof raw.message === "string" ? raw.message : message;
    } catch { /* Preserve HTTP status even when the upstream error body is not JSON. */ }
    return protocolErrorResponse(message, to, response.status, response.headers);
  }
  try {
    const stream = response.headers.get("content-type")?.includes("text/event-stream") === true;
    if (stream !== (request.stream === true)) {
      await response.body?.cancel();
      throw new ProtocolError("Upstream response does not match the requested streaming mode", undefined, 502);
    }
    const headers = responseHeaders(response.headers);
    if (stream) {
      if (!response.body) throw new ProtocolError("Empty upstream stream", undefined, 502);
      headers.set("content-type", "text/event-stream");
      return new Response(convertSse(response.body, from, to, { ...options, request }), { status: response.status, headers });
    }
    const raw = object(await response.json());
    if (raw.usage != null) options.onUsage?.(structuredClone(object(raw.usage, "usage")));
    const converted = from === "anthropic" && to === "chat" ? anthropicJsonToChat(raw)
      : from === "chat" && to === "anthropic" ? chatJsonToAnthropic(raw)
      : from === "anthropic" && to === "responses" ? anthropicJsonToResponses(raw, request)
      : from === "responses" && to === "anthropic" ? responsesJsonToAnthropic(raw)
      : unsupported(`${from} → ${to}`);
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(converted), { status: response.status, headers });
  } catch (error) { return protocolErrorResponse(error, to, 502, response.headers); }
}
