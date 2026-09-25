/**
 * Direct passthrough handler: 纯路由 + 可观测透传处理器。
 *
 * `/direct/*` 前缀请求 **完全绕开** cost-guard 路由决策、auth 校验、
 * credit 计算、model alias 改写、thinking sanitize、body 加工。
 * proxy 只承担「路由转发」职责，但仍保留可观测性（opik 上报 + jsonl 落表）。
 *
 * 路径规则（示例，upstream.url = `https://x.com/v2/`）：
 *   /direct/v1/messages/xxx   → https://x.com/v2/messages/xxx
 *   /direct/v2/embeddings     → https://x.com/v2/embeddings
 *   /direct/chat/completions  → https://x.com/v2/chat/completions
 *
 * 剥离规则：
 *   1. 去掉 `/direct` 前缀
 *   2. 若下一段是 `v1` / `v2` / `vN` 等纯数字版本号，一并去掉
 *   3. 剩余段拼接到 `upstream.url` 后面（原样保留 query string）
 *
 * 鉴权：保留客户端原始请求头（除 hop-by-hop），**不注入** `upstream.apiKey`，
 * 让上游按客户端自带的 Authorization / x-api-key 处理（"纯路由"）。
 *
 * 观测（对 Anthropic `/messages` 与 OpenAI `/chat/completions` 生效）：
 *   - request body 是 JSON 且响应含 `usage` → 写 opik trace + span + jsonl usage
 *   - 流式 → 后台 tap SSE 解析 usage / output，异步上报
 *   - 其他端点（embeddings/count_tokens/models 等）纯透传，不打点
 */

import type { Context } from "hono";
import { writeLog } from "./logger.js";
import { log } from "./report/log.js";
import {
  apiKeyToKeyId,
  extractBearerToken,
  opikCreateLlmSpan,
  opikCreateTrace,
  uuidv7,
} from "./opik.js";
import type { ProxyConfig } from "./types.js";
import { extractSpaceIdFromPath } from "./credit-reporter.js";
import { extractSseUsage, flattenMessagesForOpik } from "./handler.js";
import { resolveSessionKey } from "./guard-adapter.js";

/** Hop-by-hop headers 与 host header：不能透传到 upstream。 */
const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/** 响应头中不应回传给客户端的头（避免 stream 长度不一致等问题）。 */
const SKIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

/** 版本号段正则：v 后接一个或多个数字（`v1` / `v10` ...）。 */
const VERSION_SEGMENT_RE = /^v\d+$/i;

/** 上游协议类型。仅这两种走观测；其它端点纯透传。 */
type UpstreamProtocol = "anthropic" | "openai";

/**
 * 从 `/direct/...` 请求路径解析出 upstream 目标路径。
 *
 * 剥离规则：先去 `/direct`，再去紧跟的 `vN` 段。
 * 剥离后为空则返回 `""`（caller 决定是否拼 `/`）。
 */
export function stripDirectPrefix(requestPath: string): string {
  const directMatch = requestPath.match(/^\/direct(\/.*)?$/);
  if (!directMatch) return requestPath;

  let rest = directMatch[1] ?? "";
  if (rest === "") return "";

  const firstSegMatch = rest.match(/^\/([^/]+)(\/.*)?$/);
  if (firstSegMatch && VERSION_SEGMENT_RE.test(firstSegMatch[1] ?? "")) {
    rest = firstSegMatch[2] ?? "";
  }
  return rest;
}

/**
 * 拼接 upstream URL：upstream.url + 剥离后的路径 + query string。
 */
export function buildDirectUpstreamUrl(
  upstreamBase: string,
  requestPath: string,
  requestUrl: string,
): string {
  const stripped = stripDirectPrefix(requestPath);
  const normalizedBase = upstreamBase.replace(/\/+$/, "");
  const pathPart = stripped.startsWith("/") ? stripped : stripped ? `/${stripped}` : "";

  let query = "";
  const qIdx = requestUrl.indexOf("?");
  if (qIdx >= 0) {
    query = requestUrl.slice(qIdx);
  }

  return `${normalizedBase}${pathPart}${query}`;
}

/**
 * 根据剥离后的路径判定上游协议。返回 null 表示不做观测（纯透传）。
 */
export function detectProtocol(strippedPath: string): UpstreamProtocol | null {
  const p = strippedPath.replace(/\/+$/, "");
  if (p === "/messages") return "anthropic";
  if (p === "/chat/completions") return "openai";
  return null;
}

/** 复制请求头（剥离 hop-by-hop / host / length），保留客户端原始鉴权。 */
function buildDirectRequestHeaders(c: Context): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  return headers;
}

/** 过滤响应头（剥离长度/编码相关字段）。 */
function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}

/** 从请求头提取 API key（x-api-key 或 Authorization Bearer）。 */
function extractApiKey(c: Context): string {
  const xApiKey = c.req.header("x-api-key");
  if (xApiKey) return xApiKey;
  const authHeader =
    c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  return extractBearerToken(authHeader);
}

// ─── Anthropic messages flatten (self-contained copy) ────────────────────────

/**
 * Flatten Anthropic messages for Opik display.
 * 与 anthropicHandler 中的实现保持独立，避免耦合。
 */
function flattenAnthropicMessagesForOpik(messages: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    if (typeof content === "string") {
      result.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      result.push({ role, content: JSON.stringify(content) });
      continue;
    }

    if (role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_use") {
          toolCalls.push(b);
        } else if (b.type === "thinking" && b.thinking) {
          textParts.push(`[thinking] ${(b.thinking as string).slice(0, 200)}`);
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "assistant", content: textParts.join("\n") });
      }
      for (const tc of toolCalls) {
        const t = tc as Record<string, unknown>;
        const inputStr =
          typeof t.input === "string" ? t.input : JSON.stringify(t.input);
        result.push({
          role: "assistant",
          content: JSON.stringify(
            { tool_call_id: t.id, tool_name: t.name, input: inputStr },
            null,
            2,
          ),
        });
      }
    } else if (role === "user") {
      const textParts: string[] = [];
      const toolResults: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_result") {
          toolResults.push(b);
        } else {
          textParts.push(JSON.stringify(b));
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
      for (const tr of toolResults) {
        const t = tr as Record<string, unknown>;
        let resultContent: string;
        if (typeof t.content === "string") {
          resultContent = t.content;
        } else if (Array.isArray(t.content)) {
          resultContent = (t.content as Record<string, unknown>[])
            .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        } else {
          resultContent = JSON.stringify(t.content);
        }
        result.push({
          role: "tool",
          content: JSON.stringify(
            {
              tool_call_id: t.tool_use_id,
              is_error: t.is_error ?? false,
              result: resultContent,
            },
            null,
            2,
          ),
        });
      }
    } else {
      const merged = content
        .map((b: unknown) => {
          const block = b as Record<string, unknown>;
          if (block.type === "text") return block.text as string;
          return JSON.stringify(block);
        })
        .join("\n");
      result.push({ role, content: merged });
    }
  }
  return result;
}

// ─── Observability context ───────────────────────────────────────────────────

interface DirectObsContext {
  config: ProxyConfig;
  protocol: UpstreamProtocol;
  traceId: string;
  keyId: string;
  sessionKey: string;
  startTime: string;
  upstreamUrl: string;
  modelId: string;
  spaceId?: string;
  upstreamRequestId?: string;
  /** 已按协议 flatten 后的 input messages（供 opik 显示）。 */
  flatMessages: unknown[];
}

/** 上报 usage 到 opik + jsonl（含 request id）。 */
function reportUsage(
  ctx: DirectObsContext,
  usage: Record<string, unknown>,
  endTime: string,
  stream: boolean,
  outputMessage: { role: "assistant"; content: unknown } | null,
): void {
  try {
    writeLog(ctx.config, {
      timestamp: endTime,
      event: "usage",
      modelId: ctx.modelId,
      keyId: ctx.keyId,
      sessionKey: ctx.sessionKey,
      upstreamUrl: ctx.upstreamUrl,
      stream,
      usage,
      spaceId: ctx.spaceId,
      upstreamRequestId: ctx.upstreamRequestId,
    });
  } catch (err: unknown) {
    log.warn("direct.usage_log_failed", { error: String(err) });
  }

  try {
    opikCreateLlmSpan(ctx.config, {
      traceId: ctx.traceId,
      projectName: ctx.keyId,
      name: ctx.modelId,
      startTime: ctx.startTime,
      endTime,
      inputMessages: ctx.flatMessages,
      outputMessage,
      model: ctx.modelId,
      usage,
      tags: ["direct", `protocol:${ctx.protocol}`],
    });
  } catch (err: unknown) {
    log.warn("direct.opik_span_failed", { error: String(err) });
  }
}

// ─── SSE stream consumers ────────────────────────────────────────────────────

/**
 * 后台消费 Anthropic SSE 流：提取 usage + output text，异步上报。
 */
function consumeAnthropicStreamForObs(
  stream: ReadableStream<Uint8Array>,
  ctx: DirectObsContext,
): void {
  (async () => {
    const decoder = new TextDecoder();
    let sseBuf = "";
    const usage: Record<string, unknown> = {};
    let outputText = "";

    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuf += decoder.decode(value, { stream: true });
        const parts = sseBuf.split("\n\n");
        sseBuf = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n");
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              dataStr = line.slice(6);
            } else if (line.startsWith("data:")) {
              dataStr = line.slice(5);
            }
          }
          if (!dataStr || dataStr === "[DONE]") continue;

          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            const evtType = evt.type as string;
            if (evtType === "message_start") {
              const message = evt.message as Record<string, unknown> | undefined;
              if (message?.usage) {
                Object.assign(usage, message.usage as Record<string, unknown>);
              }
            } else if (evtType === "message_delta") {
              if (evt.usage) {
                Object.assign(usage, evt.usage as Record<string, unknown>);
              }
            } else if (evtType === "content_block_delta") {
              const delta = evt.delta as Record<string, unknown> | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                outputText += delta.text;
              }
            }
          } catch {
            // ignore malformed SSE data
          }
        }
      }
    } catch (err: unknown) {
      log.warn("direct.stream_read_failed", {
        protocol: "anthropic",
        error: String(err),
      });
    }

    if (Object.keys(usage).length === 0) return;
    reportUsage(
      ctx,
      usage,
      new Date().toISOString(),
      true,
      outputText ? { role: "assistant", content: outputText } : null,
    );
  })().catch((err: unknown) => {
    log.warn("direct.stream_consume_failed", {
      protocol: "anthropic",
      error: String(err),
    });
  });
}

/**
 * 后台消费 OpenAI SSE 流：提取 usage + assistant content，异步上报。
 */
function consumeOpenAiStreamForObs(
  stream: ReadableStream<Uint8Array>,
  ctx: DirectObsContext,
): void {
  (async () => {
    const decoder = new TextDecoder();
    let sseBuf = "";
    let lastUsage: Record<string, unknown> | null = null;
    let outputText = "";

    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuf += decoder.decode(value, { stream: true });
        const parts = sseBuf.split("\n\n");
        sseBuf = parts.pop() ?? "";

        for (const part of parts) {
          for (const line of part.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr || dataStr === "[DONE]") continue;

            try {
              const evt = JSON.parse(dataStr) as Record<string, unknown>;
              if (evt.usage && typeof evt.usage === "object") {
                lastUsage = evt.usage as Record<string, unknown>;
              }
              const choices = evt.choices as unknown[] | undefined;
              if (Array.isArray(choices) && choices.length > 0) {
                const delta = (choices[0] as Record<string, unknown>).delta as
                  | Record<string, unknown>
                  | undefined;
                if (delta && typeof delta.content === "string") {
                  outputText += delta.content;
                }
              }
            } catch {
              // ignore malformed SSE data
            }
          }
        }
      }
    } catch (err: unknown) {
      log.warn("direct.stream_read_failed", {
        protocol: "openai",
        error: String(err),
      });
    }

    if (!lastUsage || Object.keys(lastUsage).length === 0) return;
    reportUsage(
      ctx,
      lastUsage,
      new Date().toISOString(),
      true,
      outputText ? { role: "assistant", content: outputText } : null,
    );
  })().catch((err: unknown) => {
    log.warn("direct.stream_consume_failed", {
      protocol: "openai",
      error: String(err),
    });
  });
}

// ─── Non-stream response parsers ─────────────────────────────────────────────

/** 从 Anthropic 非流式响应中提取 usage + 文本 output。 */
function parseAnthropicResponse(respText: string): {
  usage: Record<string, unknown> | null;
  outputContent: string | null;
} {
  let usage: Record<string, unknown> | null = null;
  let outputContent: string | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const content = respJson.content;
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        }
      }
      outputContent = textParts.join("\n");
    }
  } catch {
    // non-JSON — skip
  }
  return { usage, outputContent };
}

/** 从 OpenAI 非流式响应中提取 usage + 文本 output。 */
function parseOpenAiResponse(respText: string): {
  usage: Record<string, unknown> | null;
  outputContent: string | null;
} {
  let usage: Record<string, unknown> | null = null;
  let outputContent: string | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const choices = respJson.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const msg = (choices[0] as Record<string, unknown>).message as
        | Record<string, unknown>
        | undefined;
      if (msg && typeof msg.content === "string") {
        outputContent = msg.content;
      }
    }
  } catch {
    // non-JSON — skip
  }
  // 兜底：若响应体本身是 SSE 或错误结构，用 extractSseUsage 再试一次
  if (!usage) {
    const sseUsage = extractSseUsage(respText);
    if (sseUsage) usage = sseUsage;
  }
  return { usage, outputContent };
}

// ─── Main handler ────────────────────────────────────────────────────────────

/**
 * `/direct/*` handler.
 */
export async function handleDirectPassthrough(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();

  const stripped = stripDirectPrefix(c.req.path);
  const upstreamUrl = buildDirectUpstreamUrl(
    config.upstream.url,
    c.req.path,
    c.req.url,
  );
  const method = c.req.method.toUpperCase();

  const protocol = method === "POST" ? detectProtocol(stripped) : null;

  // ── 分支 A：无观测的极简透传（非 messages / chat 端点，或非 POST） ─────────
  if (!protocol) {
    const headers = buildDirectRequestHeaders(c);
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? c.req.raw.body : null;

    log.debug("direct.forward_start", {
      method,
      requestPath: c.req.path,
      upstreamUrl,
      observed: false,
    });

    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method,
        headers,
        body,
        ...(body ? { duplex: "half" } : {}),
      } as RequestInit);
    } catch (err: unknown) {
      log.error(
        "direct.forward_failed",
        { method, requestPath: c.req.path, upstreamUrl },
        err instanceof Error ? err : new Error(String(err)),
      );
      return c.json(
        {
          error: "Upstream request failed",
          detail: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: filterResponseHeaders(upstreamResp.headers),
    });
  }

  // ── 分支 B：观测 + 透传 ──────────────────────────────────────────────────
  const rawBody = await c.req.arrayBuffer();
  const bodyText = new TextDecoder().decode(rawBody);
  let parsedBody: Record<string, unknown> | null = null;
  try {
    parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    // 非 JSON body：降级为纯透传（不做观测）
  }

  const modelId =
    parsedBody && typeof parsedBody.model === "string"
      ? parsedBody.model
      : "unknown";
  const messages =
    parsedBody && Array.isArray(parsedBody.messages) ? parsedBody.messages : [];
  const isStream = parsedBody?.stream === true;

  const apiKey = extractApiKey(c);
  const keyId = apiKey ? apiKeyToKeyId(apiKey) : "unknown";
  const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";

  // ── SessionKey：复用 cost-guard 的 agent-profile 解析（从请求头提取
  //    conversation id），与主 handler 行为一致。
  const lcHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    lcHeaders[k.toLowerCase()] = v;
  }
  const sessionKey = resolveSessionKey(
    config,
    lcHeaders,
    c.req.path,
    parsedBody ?? {},
    keyId,
  );

  const headers = buildDirectRequestHeaders(c);

  log.debug("direct.forward_start", {
    method,
    requestPath: c.req.path,
    upstreamUrl,
    observed: true,
    protocol,
    modelId,
    isStream,
  });

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method,
      headers,
      body: rawBody,
    });
  } catch (err: unknown) {
    log.error(
      "direct.forward_failed",
      { method, requestPath: c.req.path, upstreamUrl, protocol },
      err instanceof Error ? err : new Error(String(err)),
    );
    return c.json(
      {
        error: "Upstream request failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }

  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";
  const respHeaders = filterResponseHeaders(upstreamResp.headers);

  // 按协议 flatten input（供 opik trace/span 显示）
  const flatMessages =
    protocol === "anthropic"
      ? flattenAnthropicMessagesForOpik(messages)
      : flattenMessagesForOpik(messages);

  // 只有能解析到 body 时才建 trace
  if (parsedBody) {
    opikCreateTrace(config, {
      traceId,
      projectName: keyId,
      name: `${modelId} / ${keyId}`,
      startTime,
      input: { messages: flatMessages },
      tags: [
        `protocol:${protocol}`,
        isStream ? "stream" : "non-stream",
        `session:${sessionKey}`,
        "direct",
      ],
    });
  }

  const obsCtx: DirectObsContext = {
    config,
    protocol,
    traceId,
    keyId,
    sessionKey,
    startTime,
    upstreamUrl,
    modelId,
    spaceId,
    upstreamRequestId,
    flatMessages,
  };

  // ── 流式 ──
  if (isStream) {
    if (!upstreamResp.body) {
      return new Response(null, {
        status: upstreamResp.status,
        headers: respHeaders,
      });
    }
    // tee：一份给客户端，一份后台消费用于打点
    const [clientStream, tapStream] = upstreamResp.body.tee();
    if (parsedBody) {
      if (protocol === "anthropic") {
        consumeAnthropicStreamForObs(tapStream, obsCtx);
      } else {
        consumeOpenAiStreamForObs(tapStream, obsCtx);
      }
    } else {
      tapStream.cancel().catch(() => {});
    }
    return new Response(clientStream, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  }

  // ── 非流式 ──
  const respBuf = await upstreamResp.arrayBuffer();
  const respText = new TextDecoder().decode(respBuf);
  const endTime = new Date().toISOString();

  if (parsedBody) {
    const { usage, outputContent } =
      protocol === "anthropic"
        ? parseAnthropicResponse(respText)
        : parseOpenAiResponse(respText);

    if (usage && upstreamResp.ok) {
      reportUsage(
        obsCtx,
        usage,
        endTime,
        false,
        outputContent ? { role: "assistant", content: outputContent } : null,
      );
    }
  }

  return new Response(respBuf, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}
