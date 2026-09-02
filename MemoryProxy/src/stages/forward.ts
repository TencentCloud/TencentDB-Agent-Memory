/**
 * 转发阶段：统一 4 个 handler 的上游转发路径。
 *
 * 两种形态用参数收敛：
 *   - chat / anthropic（raw）：cost-guard 已解析 target + 调用方预建的转发体，
 *     stage 负责 鉴权头、debug dump、限流、fetch + 重试，返回上游 Response 与
 *     retried 标记；响应后续处理（usage / obs / archive）留在 handler（后续阶段）。
 *   - responses（shape）：codex / workbuddy 的 per-agent 上游覆盖、协议翻译、
 *     SSE/JSON 塑形与 tap 在此收敛，直接返回最终客户端 Response。
 */
import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import type { ReqCtx } from "./types.js";
import type { ForwardTarget } from "../guard-adapter.js";
import { joinUrl } from "../guard-adapter.js";
import { collectRequestHeaders, filterResponseHeaders } from "../upstream/headers.js";
import type { createPipeline } from "../logger.js";
import {
  enforceRateLimit,
  isRateLimitExceededError,
  type RateLimitProtocol,
} from "../rate-limit/guard.js";
import {
  chatJsonToResponses,
  createChatSseToResponses,
  responsesBodyToChat,
} from "../common/responses-chat-compat.js";
import {
  anthropicJsonToResponsesJson,
  createAnthropicSseToResponsesSse,
  responsesToAnthropic,
} from "../common/responses-anthropic-compat.js";
import { stripCodexFormArtifacts } from "../session/codex/form.js";

/** stage 只读 ctx.c / ctx.config；aux 路径可用最小对象。 */
export type ForwardStageCtx = Pick<ReqCtx, "c" | "config">;

/** 重试兜底目标（与 cost-guard 的 RetryTarget 结构一致）。 */
export interface RetryTargetLike {
  url: string;
  model: string;
  authHeaders: Record<string, string> | null;
}

/** 钩子元信息：stage 内才知道的值（如上游 URL），透传给 handler 闭包。 */
export interface ForwardHookMeta {
  upstreamUrl: string;
  /** 上游响应 content-type（workbuddy 4xx 观测上报需要）。 */
  contentType: string;
}

/** responses 塑形阶段参数：把 codex / workbuddy 的响应塑形差异收敛到这里。 */
export interface ForwardStageShapeOptions {
  enabled: boolean;
  /** 解析后的模型 ID（协议翻译与响应塑形用）。 */
  modelId: string;
  /**
   * 4xx/5xx 处理：
   *   - "read"（codex）：读取 body 文本并直接原样返回；
   *   - "passthrough"（workbuddy）：只上报（onErrorStatus）后继续走塑形/透传。
   */
  errorBody: "read" | "passthrough";
  /** 上游 4xx/5xx 时的观测上报（codex 带 body 文本；workbuddy 为 null）。 */
  onErrorStatus?: (
    status: number,
    bodyText: string | null,
    meta: ForwardHookMeta,
  ) => void | Promise<void>;
  /** fetch 网络失败时的处理（codex/workbuddy 各自上报 langfuse 并返回 502）。 */
  onFetchError?: (err: unknown, meta: ForwardHookMeta) => Response | Promise<Response>;
  /** SSE 流 tap：handler 传入 consumeCodexStream / consumeWorkbuddyStream 的闭包。 */
  tap?: {
    enabled: boolean;
    consume: (stream: ReadableStream<Uint8Array>, meta: ForwardHookMeta) => void;
  };
  /** fetch 前钩子（workbuddy 的 request 日志在 fetch 前）。 */
  beforeFetch?: (meta: ForwardHookMeta) => void;
  /** fetch 成功后钩子（codex 的 request 日志在 forwardDone 后）。 */
  afterFetch?: (status: number, meta: ForwardHookMeta) => void;
}

export interface ForwardStageOptions {
  protocol: "chat" | "anthropic" | "responses";
  pipe: ReturnType<typeof createPipeline>;
  /**
   * 转发体：
   *   - chat/anthropic：handler 已翻译/压缩好的上游 body；
   *   - responses：stage 内部再做 max_tokens 截断、form 剥离与协议翻译。
   */
  body: Record<string, unknown>;
  /** chat/anthropic：cost-guard 已解析的目标（含 url/model/authHeaders/retryTarget）。 */
  target?: ForwardTarget;
  /** responses：per-agent 覆盖键（codex / workbuddy）。 */
  agent?: string;
  /** responses → chat 兼容（chatCompletions: true）。 */
  chatCompletions?: boolean;
  /** responses → anthropic 兼容（responsesToAnthropic: true）。 */
  responsesToAnthropic?: boolean;
  /** responses 显式上游路径；缺省 c.req.path（workbuddy 传去掉前缀后的路径）。 */
  path?: string;
  /** responses 是否显式设 content-type（codex 设；workbuddy 沿用客户端头）。 */
  setContentType?: boolean;
  auth?: {
    /** 有效服务器侧 key；空串/缺省 = 透传客户端 key（chat/anthropic 已预解析）。 */
    apiKey?: string;
    sessionKey?: string;
  };
  retry?: {
    target?: RetryTargetLike;
    /** 重试体：chat 用客户端原 body（覆盖 model）；anthropic 用 sanitize 后的原 body。 */
    originalBody?: Record<string, unknown>;
    originalHeaders?: Record<string, string>;
    /** openai 重试体覆盖 model；anthropic 不覆盖。 */
    bodyModelOverride?: boolean;
    rateLimit?: { instanceId?: string };
  };
  /** 0/缺省 = 不设超时（responses 原行为）。 */
  timeoutMs?: number;
  /** responses 塑形开关；chat/anthropic 不传。 */
  shape?: ForwardStageShapeOptions;
}

/** 构建上游头所需的选项子集（prepareUpstreamRequest 等 handler 侧共用）。 */
export type ForwardHeaderOptions = Pick<
  ForwardStageOptions,
  | "protocol"
  | "target"
  | "agent"
  | "chatCompletions"
  | "responsesToAnthropic"
  | "path"
  | "setContentType"
  | "auth"
>;

export interface ForwardStageResult {
  resp: Response;
  retried: boolean;
  upstreamUrl: string;
  effectiveModel: string;
  upstreamHeaders: Record<string, string>;
  upstreamBody: Record<string, unknown>;
}

const ZHIPU_MAX_TOKENS_CEIL = 32768;

/** rate-limit 只对 chat/anthropic 生效；responses 无此路径，映射仅用于类型收窄。 */
function toRateLimitProtocol(protocol: ForwardStageOptions["protocol"]): RateLimitProtocol {
  return protocol === "anthropic" ? "anthropic" : "openai";
}

/** 上游 URL：chat/anthropic 用 target.url；responses 用 per-agent 覆盖 + 兼容路径。 */
function resolveUpstreamUrl(
  c: Context,
  config: ProxyConfig,
  opts: ForwardStageOptions,
): string {
  if (opts.target) return opts.target.url;
  const entry = opts.agent ? config.upstream.agents?.[opts.agent] : undefined;
  const chatCompat = opts.chatCompletions === true;
  const r2a = opts.responsesToAnthropic === true;
  const upstreamBase = (entry?.url || config.upstream.url || "").replace(/\/+$/, "");
  const upstreamPath = chatCompat
    ? "/chat/completions"
    : r2a
      ? "/messages"
      : opts.path ?? c.req.path;
  return joinUrl(upstreamBase, upstreamPath);
}

/** 上游头：4 个 handler 的鉴权/头构建差异按协议收敛。 */
export function buildForwardHeaders(
  c: Context,
  config: ProxyConfig,
  opts: ForwardHeaderOptions,
): Record<string, string> {
  const headers = collectRequestHeaders(c);
  if (opts.protocol === "responses") {
    if (opts.setContentType) headers["content-type"] = "application/json";
    if (config.upstream.apiKey) {
      headers["authorization"] = `Bearer ${config.upstream.apiKey}`;
      delete headers["x-api-key"];
    }
    const entry = opts.agent ? config.upstream.agents?.[opts.agent] : undefined;
    if (entry?.apiKey) {
      headers["authorization"] = `Bearer ${entry.apiKey}`;
      delete headers["x-api-key"];
    }
    if (opts.responsesToAnthropic) {
      // Anthropic 兼容上游要求版本头；Authorization Bearer 与 chat 路径一致
      headers["anthropic-version"] = "2023-06-01";
    }
    return headers;
  }

  headers["content-type"] = "application/json";
  const effectiveApiKey = opts.auth?.apiKey;
  if (effectiveApiKey && !opts.target?.authHeaders) {
    const agent = c.req.path.split("/")[1] ?? "claude-code";
    const agentCfg = config.upstream.agents?.[agent];
    if (opts.protocol === "chat") {
      if (agentCfg?.chatToAnthropic === true) {
        // TRACK 05A：转成 Anthropic 后上游要 x-api-key + anthropic-version。
        headers["x-api-key"] = effectiveApiKey;
        headers["anthropic-version"] = "2023-06-01";
        delete headers["authorization"];
      } else {
        headers["authorization"] = `Bearer ${effectiveApiKey}`;
      }
    } else if (
      agentCfg?.anthropicToChat === true ||
      agentCfg?.anthropicToResponses === true
    ) {
      // TRACK 05A/05B：转成 Chat / Responses 后上游要 OpenAI 风格鉴权。
      headers["authorization"] = `Bearer ${effectiveApiKey}`;
      delete headers["x-api-key"];
      delete headers["anthropic-version"];
    } else {
      headers["x-api-key"] = effectiveApiKey;
      delete headers["authorization"];
    }
  }
  if (opts.target?.authHeaders) {
    for (const [k, v] of Object.entries(opts.target.authHeaders)) {
      headers[k] = v;
      if (opts.protocol === "anthropic") {
        if (k === "x-api-key") delete headers["authorization"];
        if (k === "authorization") delete headers["x-api-key"];
      }
    }
  }
  if (opts.auth?.sessionKey) {
    headers["x-vertex-ai-session-id"] = opts.auth.sessionKey;
  }
  return headers;
}

/** 转发体：chat/anthropic 原样使用；responses 做 codex 侧截断/剥离与协议翻译。 */
function buildForwardBody(opts: ForwardStageOptions): Record<string, unknown> {
  if (opts.protocol !== "responses") return opts.body;
  let safeBody = { ...opts.body };
  if (opts.agent === "codex") {
    // 智谱 glm 系列 token 参数上限截断（[1210] max_tokens 参数非法）。
    for (const k of ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const) {
      const v = safeBody[k];
      if (typeof v === "number" && v > ZHIPU_MAX_TOKENS_CEIL) {
        safeBody[k] = ZHIPU_MAX_TOKENS_CEIL;
      }
    }
    // 转发前剥离 codex session-init 假表单（function_call + output + 工具声明）。
    safeBody = stripCodexFormArtifacts(safeBody);
  }
  if (opts.chatCompletions) {
    return responsesBodyToChat(safeBody, { model: opts.shape?.modelId ?? "" });
  }
  if (opts.responsesToAnthropic) {
    return responsesToAnthropic(safeBody, { model: opts.shape?.modelId ?? "" });
  }
  return safeBody;
}

/** 全量 body dump（dev only，原 chat handler 行为）。 */
async function maybeDumpBody(
  opts: ForwardStageOptions,
  upstreamUrl: string,
  headers: Record<string, string>,
  upstreamBody: Record<string, unknown>,
): Promise<void> {
  if (opts.protocol === "responses" || !process.env.PROXY_DEBUG_DUMP_BODY) return;
  try {
    const fs = await import("node:fs");
    const dir = process.env.PROXY_DEBUG_DUMP_BODY;
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const fn = `${dir}/${ts}-${opts.auth?.sessionKey ?? "nosid"}.json`;
    fs.writeFileSync(
      fn,
      JSON.stringify({ url: upstreamUrl, headers, body: upstreamBody }, null, 2),
    );
    console.log(`[dump-body] wrote ${fn}`);
  } catch (e) {
    console.log(`[dump-body] error: ${(e as Error).message}`);
  }
}

/** 出站 body md5（dev only；chat/anthropic 各自的三段/两段 md5 口径）。 */
function maybeLogOutboundMd5(
  opts: ForwardStageOptions,
  upstreamBody: Record<string, unknown>,
): void {
  if (opts.protocol === "responses" || !process.env.PROXY_DEBUG_DUMP_OUTBOUND_MD5) return;
  const session = opts.auth?.sessionKey ?? "?";
  try {
    if (opts.protocol === "anthropic") {
      // Anthropic KV cache 命中要求 body 头 → cache_control anchor 前 bytes 完全一致。
      const sys = (upstreamBody as { system?: unknown }).system;
      const sysFullStr = sys === undefined ? "" : JSON.stringify(sys);
      const sysTextStr =
        typeof sys === "string"
          ? sys
          : Array.isArray(sys)
            ? sys.map((b) => (b as { text?: string }).text ?? "").join("\n")
            : "";
      const msgs = (upstreamBody as { messages?: Array<Record<string, unknown>> }).messages ?? [];
      let anchorIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const content = msgs[i]?.content;
        if (Array.isArray(content)) {
          const hasCache = content.some(
            (b) => b && typeof b === "object" && "cache_control" in (b as object),
          );
          if (hasCache) {
            anchorIdx = i;
            break;
          }
        }
      }
      const prefixEnd = anchorIdx >= 0 ? anchorIdx + 1 : msgs.length;
      const msgsPrefixStr = JSON.stringify(msgs.slice(0, prefixEnd));
      const sysFullMd5 = createHash("md5").update(sysFullStr).digest("hex").slice(0, 12);
      const sysTextMd5 = createHash("md5").update(sysTextStr).digest("hex").slice(0, 12);
      const msgsPrefixMd5 = createHash("md5").update(msgsPrefixStr).digest("hex").slice(0, 12);
      // eslint-disable-next-line no-console
      console.log(
        `[outbound-md5] session=${session} sysBytes=${sysFullStr.length} sysFullMd5=${sysFullMd5} sysTextMd5=${sysTextMd5} msgsCount=${msgs.length} msgsAnchorIdx=${anchorIdx} msgsPrefixBytes=${msgsPrefixStr.length} msgsPrefixMd5=${msgsPrefixMd5}`,
      );
    } else {
      // openai 协议侧没有 cache_control 概念，只算 sys + 整个 messages 数组两个 md5。
      const msgs = (upstreamBody as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
      const sysMsg = msgs.find((m) => m.role === "system");
      const sysStr =
        typeof sysMsg?.content === "string"
          ? sysMsg.content
          : sysMsg?.content
            ? JSON.stringify(sysMsg.content)
            : "";
      const msgsFullStr = JSON.stringify(msgs);
      const sysMd5 = createHash("md5").update(sysStr).digest("hex").slice(0, 12);
      const msgsFullMd5 = createHash("md5").update(msgsFullStr).digest("hex").slice(0, 12);
      // eslint-disable-next-line no-console
      console.log(
        `[outbound-md5] session=${session} protocol=openai sysBytes=${sysStr.length} sysMd5=${sysMd5} msgsCount=${msgs.length} msgsFullBytes=${msgsFullStr.length} msgsFullMd5=${msgsFullMd5}`,
      );
    }
  } catch (e) {
    // best-effort；不应因 debug 崩流程
    // eslint-disable-next-line no-console
    console.log(`[outbound-md5] session=${session} <error: ${(e as Error).message}>`);
  }
}

/** responses 响应塑形：4xx、SSE/JSON 翻译、tap 透传（codex/workbuddy 收敛）。 */
async function shapeResponse(
  c: Context,
  upstreamResp: Response,
  opts: ForwardStageOptions,
  upstreamUrl: string,
): Promise<Response> {
  const shape = opts.shape!;
  const status = upstreamResp.status;
  const respHeaders = filterResponseHeaders(upstreamResp.headers);
  const contentType = upstreamResp.headers.get("content-type") ?? "";
  const isSSE = contentType.includes("text/event-stream");

  if (status >= 400) {
    if (shape.errorBody === "read") {
      const errText = await upstreamResp.text();
      await shape.onErrorStatus?.(status, errText, { upstreamUrl, contentType });
      return new Response(errText, { status, headers: respHeaders });
    }
    await shape.onErrorStatus?.(status, null, { upstreamUrl, contentType });
  }

  const chatCompat = opts.chatCompletions === true;
  const r2a = opts.responsesToAnthropic === true;
  const modelId = shape.modelId;
  const needTap = shape.tap?.enabled === true && upstreamResp.body != null;

  if (chatCompat || r2a) {
    const sseHeaders = new Headers(respHeaders);
    sseHeaders.set("content-type", "text/event-stream");
    if (isSSE && upstreamResp.body) {
      const transformed = r2a
        ? upstreamResp.body.pipeThrough(createAnthropicSseToResponsesSse({ model: modelId }))
        : upstreamResp.body.pipeThrough(createChatSseToResponses({ model: modelId }));
      if (!needTap) {
        return new Response(transformed, { status, headers: sseHeaders });
      }
      const [passStream, tapStream] = transformed.tee();
      shape.tap!.consume(tapStream, { upstreamUrl, contentType });
      return new Response(passStream, { status, headers: sseHeaders });
    }
    // 非 SSE：上游 JSON → Responses JSON（上游统一 stream:true，此为兜底）。
    const rawText = await upstreamResp.text();
    try {
      const json = JSON.parse(rawText) as Record<string, unknown>;
      const responsesJson = r2a
        ? anthropicJsonToResponsesJson(json, { model: modelId })
        : chatJsonToResponses(json, { model: modelId });
      return c.json(responsesJson);
    } catch {
      return new Response(rawText, { status, headers: respHeaders });
    }
  }

  if (!needTap) {
    return new Response(upstreamResp.body, { status, headers: respHeaders });
  }
  const [passStream, tapStream] = upstreamResp.body!.tee();
  shape.tap!.consume(tapStream, { upstreamUrl, contentType });
  return new Response(passStream, { status, headers: respHeaders });
}

/**
 * 统一转发入口。raw 模式（chat/anthropic）返回上游 Response + retried；
 * shape 模式（responses）返回最终客户端 Response。
 */
export async function forwardStage(
  ctx: ForwardStageCtx,
  opts: ForwardStageOptions,
): Promise<ForwardStageResult> {
  const { c, config } = ctx;
  const { pipe, protocol } = opts;
  const upstreamUrl = resolveUpstreamUrl(c, config, opts);
  const upstreamHeaders = buildForwardHeaders(c, config, opts);
  const upstreamBody = buildForwardBody(opts);

  if (opts.agent === "codex" && opts.responsesToAnthropic) {
    pipe.info("PROTOCOL", "codex responses→anthropic (responsesToAnthropic)");
  }

  await maybeDumpBody(opts, upstreamUrl, upstreamHeaders, upstreamBody);
  maybeLogOutboundMd5(opts, upstreamBody);

  const timeoutMs = opts.timeoutMs ?? 0;
  const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const fetchInit: RequestInit = {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(upstreamBody),
  };
  if (signal) fetchInit.signal = signal;

  pipe.forwardStart(upstreamUrl);
  opts.shape?.beforeFetch?.({ upstreamUrl, contentType: "" });
  if (opts.retry?.rateLimit && opts.target) {
    await enforceRateLimit({
      config,
      instanceId: opts.retry.rateLimit.instanceId,
      modelId: opts.target.model,
      protocol: toRateLimitProtocol(protocol),
    });
  }

  let upstreamResp: Response | undefined;
  let forwardFailed = false;
  try {
    upstreamResp = await fetch(upstreamUrl, fetchInit);
  } catch (err: unknown) {
    if (opts.shape?.enabled) {
      if (!opts.shape.onFetchError) throw new Error("Upstream request failed");
      return {
        resp: await opts.shape.onFetchError(err, { upstreamUrl, contentType: "" }),
        retried: false,
        upstreamUrl,
        effectiveModel: opts.shape.modelId,
        upstreamHeaders,
        upstreamBody,
      };
    }
    if (err instanceof DOMException && err.name === "TimeoutError") {
      pipe.error("FORWARD", `Timeout after ${timeoutMs / 1000}s`);
    } else {
      pipe.error("FORWARD", err);
    }
    forwardFailed = true;
  }

  if (upstreamResp) {
    pipe.forwardDone(upstreamResp.status);
  }
  opts.shape?.afterFetch?.(upstreamResp?.status ?? 0, { upstreamUrl, contentType: "" });

  const retryTarget = opts.retry?.target;
  const shouldRetry =
    Boolean(retryTarget) &&
    (forwardFailed || (upstreamResp && upstreamResp.status >= 400 && upstreamResp.status < 500));
  if (shouldRetry && retryTarget) {
    const reason = forwardFailed ? "timeout/error" : `${upstreamResp!.status}`;
    pipe.info(
      "RETRY",
      `Routed model failed (${reason}), retryUrl=${retryTarget.url} model=${retryTarget.model}`,
    );
    const retryBody = opts.retry!.bodyModelOverride
      ? { ...opts.retry!.originalBody, model: retryTarget.model }
      : opts.retry!.originalBody;
    const retryHeaders: Record<string, string> = { ...opts.retry!.originalHeaders };
    retryHeaders["content-type"] = "application/json";
    if (opts.auth?.sessionKey) {
      retryHeaders["x-vertex-ai-session-id"] = opts.auth.sessionKey;
    }
    try {
      if (opts.retry!.rateLimit) {
        await enforceRateLimit({
          config,
          instanceId: opts.retry!.rateLimit.instanceId,
          modelId: retryTarget.model,
          protocol: toRateLimitProtocol(protocol),
        });
      }
      upstreamResp = await fetch(retryTarget.url, {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify(retryBody),
        ...(signal ? { signal } : {}),
      });
      if (upstreamResp.ok) {
        pipe.info("RETRY_SUCCESS", `Retry returned ${upstreamResp.status}`);
      } else {
        pipe.error("RETRY_FAILED", `Retry returned ${upstreamResp.status}`);
      }
      return {
        resp: upstreamResp,
        retried: true,
        upstreamUrl,
        effectiveModel: retryTarget.model,
        upstreamHeaders,
        upstreamBody,
      };
    } catch (retryErr: unknown) {
      if (isRateLimitExceededError(retryErr)) throw retryErr;
      if (retryErr instanceof DOMException && retryErr.name === "TimeoutError") {
        pipe.error("RETRY_FORWARD", `Timeout after ${timeoutMs / 1000}s`);
      } else {
        pipe.error("RETRY_FORWARD", retryErr);
      }
      throw new Error("Upstream request failed");
    }
  }

  if (forwardFailed && !shouldRetry) {
    throw new Error("Upstream request failed");
  }
  if (!upstreamResp) {
    throw new Error("No upstream response available");
  }

  const effectiveModel = opts.target?.model ?? opts.shape?.modelId ?? "";
  if (opts.shape?.enabled) {
    const resp = await shapeResponse(c, upstreamResp, opts, upstreamUrl);
    return { resp, retried: false, upstreamUrl, effectiveModel, upstreamHeaders, upstreamBody };
  }
  return {
    resp: upstreamResp,
    retried: false,
    upstreamUrl,
    effectiveModel,
    upstreamHeaders,
    upstreamBody,
  };
}
