/**
 * Langfuse LLM trace 上报模块（官方 SDK 方式）。
 *
 * 使用 Langfuse 官方 SDK（@langfuse/tracing + @langfuse/otel）上报 LLM 调用。
 *
 * 核心语义：**一个 trace = 一个会话里的一次用户输入（一个 turn）**。
 *   - 同一 turn 内的工具循环（model → tool → model → …）会产生多次 upstream 请求，
 *     它们共享同一个确定性 traceId，因此在 Langfuse 里归并到同一个 trace 下，
 *     每次 LLM 调用是该 trace 下的一个 generation observation。
 *   - traceId 由 `sessionKey + turnSeq` 经 SHA-256 派生（确定性），与官方
 *     `createTraceId(seed)` 的算法逐字节一致（取 SHA-256 hex 前 32 位）。
 *
 * 跨请求归并的机制：
 *   一个 turn 的多次请求是彼此独立的 HTTP handler 调用，没有共享的 async context。
 *   因此通过 `startObservation(..., { parentSpanContext: { traceId, ... } })` 显式把
 *   每个 generation 挂到已知的确定性 traceId 下（SDK 内部走
 *   `trace.setSpanContext(context.active(), parentSpanContext)`）。
 *
 * 设计原则：
 *   - Fire-and-forget：span 由 LangfuseSpanProcessor 异步批量导出
 *   - 配置缺失 / SDK 初始化失败时 graceful degradation（全部 no-op）
 *   - 与 Opik 上报完全独立（各用各的 traceId）
 */

import { createHash } from "node:crypto";
import { TraceFlags } from "@opentelemetry/api";
import { startObservation, LangfuseOtelSpanAttributes } from "@langfuse/tracing";
import type { ProxyConfig } from "./types.js";
import { log } from "./report/log.js";

// ============================
// 生命周期
// ============================

let _enabled = false;
let _initCalled = false;
// OpenTelemetry NodeSDK 实例（用于优雅关闭时 flush）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sdk: { shutdown: () => Promise<void> } | null = null;

/**
 * 初始化 Langfuse 上报。在 server 启动时调用一次，后续调用为 no-op。
 * 返回是否成功启用。
 */
export async function initLangfuse(config: ProxyConfig): Promise<boolean> {
  if (_initCalled) return _enabled;
  _initCalled = true;

  const lf = config.langfuse;
  if (!lf.enabled || !lf.host || !lf.publicKey || !lf.secretKey) {
    log.info("langfuse.disabled", { reason: "config not complete" });
    return false;
  }

  try {
    // BatchSpanProcessor 的 maxQueueSize 只能通过 OTel env var 注入（Langfuse 构造器不透传）。
    // 在 SDK 初始化前设好，确保 BatchSpanProcessor 读到我们的值。
    if (lf.maxQueueSize && !process.env.OTEL_BSP_MAX_QUEUE_SIZE) {
      process.env.OTEL_BSP_MAX_QUEUE_SIZE = String(lf.maxQueueSize);
    }

    const [{ NodeSDK }, { LangfuseSpanProcessor }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@langfuse/otel"),
    ]);

    const baseUrl = lf.host.replace(/\/$/, "");
    const processor = new LangfuseSpanProcessor({
      publicKey: lf.publicKey,
      secretKey: lf.secretKey,
      baseUrl,
      flushAt: lf.flushAt || undefined,           // 每批最大 span 数
      flushInterval: lf.flushInterval || undefined, // 定时 flush 间隔（秒）
    });

    const sdk = new NodeSDK({ spanProcessors: [processor] });
    sdk.start();
    _sdk = sdk;
    _enabled = true;

    log.info("langfuse.initialized", {
      baseUrl,
      flushAt: lf.flushAt,
      flushInterval: lf.flushInterval,
      maxQueueSize: lf.maxQueueSize,
    });
    return true;
  } catch (err: unknown) {
    log.warn("langfuse.init_failed", { error: String(err) });
    _enabled = false;
    return false;
  }
}

/**
 * 优雅关闭 Langfuse 上报，确保所有待发送 span 已 flush。
 */
export async function shutdownLangfuse(): Promise<void> {
  if (_sdk) {
    try {
      await _sdk.shutdown();
    } catch (err: unknown) {
      log.warn("langfuse.shutdown_error", { error: String(err) });
    }
    _sdk = null;
  }
  _enabled = false;
  _initCalled = false;
}

// ============================
// 确定性 turn traceId
// ============================

/**
 * 由 `sessionKey + turnSeq` 派生确定性 traceId（32 位小写 hex）。
 *
 * 与官方 `createTraceId(seed)` 算法一致：SHA-256(seed) 的 hex 取前 32 位。
 * 同一 turn 内每次请求都用相同 (sessionKey, turnSeq) → 得到相同 traceId →
 * 在 Langfuse 中归并到同一个 trace。
 */
export function langfuseTurnTraceId(sessionKey: string, turnSeq: number): string {
  const seed = `${sessionKey}:${turnSeq}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

// ============================
// 上报：generation observation
// ============================

/**
 * Langfuse turn-trace 上下文 —— 同属一个 turn（一个 Langfuse trace）的所有
 * generation 共享的 trace 级属性。由 handler 构造后传给各上报函数。
 */
export interface LangfuseTurnContext {
  /** 该 turn 的确定性 traceId（langfuseTurnTraceId 生成）。 */
  traceId: string;
  /** turn 序号（countHumanTurns）—— 也用于 ClickHouse 按 turn 聚合。 */
  turnSeq: number;
  /** trace 名。 */
  traceName: string;
  /** trace userId（一般为 keyId）。 */
  userId: string;
  /** trace sessionId（会话隔离键；可据此聚合多个 turn）。 */
  sessionId: string;
  /**
   * trace 级标签 —— 只放该 turn 内稳定的维度（protocol / stream / session），
   * 不含随请求变化的路由标签，避免同一 turn 的工具循环请求互相覆盖（last-write-wins）。
   */
  tags: string[];
  /**
   * 本次请求的 observation 级附加标签 —— 随请求变化，写入 generation 的
   * observation metadata，而非 trace 级 tags。宿主默认不填充。
   */
  routeTags: string[];
  /**
   * 去噪后的最新用户问题 —— 仅在该 turn 首次人类输入请求非空，工具循环延续时为 ""。
   * 用作 trace 级 input。
   */
  userQuery: string;
}

/** 一次 LLM 调用的上报参数（挂到指定 turn trace 下的 generation）。 */
export interface LangfuseGenerationReport {
  /** 所属 turn 的确定性 traceId（langfuseTurnTraceId 生成）。 */
  traceId: string;
  /** observation 名称（一般为模型名，或 `[internal] <model>`）。 */
  name: string;
  /** 模型名。 */
  model: string;
  /** ISO 8601 开始时间。 */
  startTime: string;
  /** ISO 8601 结束时间。 */
  endTime: string;
  /** generation 输入（messages 数组或字符串）。 */
  input?: unknown;
  /** generation 输出（assistant message 或字符串）。 */
  output?: unknown;
  /** 原始 usage 对象（会被归一化为 Langfuse usageDetails）。 */
  usage?: Record<string, unknown>;
  /** observation 级别（默认 DEFAULT；失败时传 ERROR）。 */
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  /** 状态信息（一般用于 ERROR，描述失败原因）。 */
  statusMessage?: string;
  // ── trace 级属性（同一 turn 的多次调用应传相同值；last-write-wins）──
  /** trace 名。 */
  traceName: string;
  /** trace userId（一般为 keyId）。 */
  userId: string;
  /** trace sessionId（会话隔离键；Langfuse 上可据此聚合多个 turn）。 */
  sessionId: string;
  /** trace 标签。 */
  tags?: string[];
  /**
   * trace 级 input —— 仅在该 turn 的"首次人类输入"请求传入（传 turn 最初的用户问题）。
   * 工具循环延续请求应留空，避免把带 tool_result 的请求体覆盖成 trace input。
   * 内部路由等子步骤也应留空，避免污染 trace 级输入。
   */
  traceInput?: unknown;
  /**
   * trace 级 output —— 传该 turn 的最终回答。同一 turn 多次调用 last-write-wins，
   * 因此最后一次（turn 收尾）的输出会成为 trace output。
   */
  traceOutput?: unknown;
  /** trace 级 metadata。 */
  traceMetadata?: Record<string, unknown>;
  /** observation 级 metadata。 */
  observationMetadata?: Record<string, unknown>;
}

/**
 * 派生一个合法的 phantom parent spanId（16 位 hex，非零）。
 * 用于把 generation 挂到确定性 traceId 下。同一 traceId 始终得到同一 spanId，
 * 因此一个 turn 内所有 generation 的 parent 一致（指向同一个不存在的 root span，
 * Langfuse 据此把它们都视为该 trace 下的顶层 observation）。
 */
function deriveParentSpanId(traceId: string): string {
  return traceId.slice(0, 16);
}

/**
 * 归一化原始 LLM usage → Langfuse usageDetails（Record<string, number>）。
 *
 * Token 口径与 ClickHouse 的 `buildClickHouseRow` 保持一致（此处独立复刻，不跨模块依赖），
 * 覆盖 Anthropic / OpenAI / DeepSeek 三种 usage 格式：
 *   - Anthropic(TokenHub)：`input_tokens` 已排除 cache，总输入 = input + cache_read + cache_write，
 *     且响应无 `total_tokens`，需回退为 prompt + completion。
 *   - OpenAI / DeepSeek：`prompt_tokens` 即含 cache 的总输入，通常也带 `total_tokens`。
 *
 * 输出遵循 Langfuse 惯例（各分项之和 = total，避免与内置 cost 计算重复计数）：
 *   - `input`：未命中缓存的输入（= 总输入 − cache_read − cache_write），按 input 单价计费
 *   - `cache_read_input_tokens` / `cache_creation_input_tokens`：缓存读 / 写
 *   - `output`：输出
 *   - `total`：总 token（= 总输入 + 输出）
 *
 * 修复要点：此前 `total = input_tokens + output_tokens` 对 Anthropic 会漏掉 cache token
 * （cache 常占绝大多数），导致 Langfuse 的 total 少一到两个数量级。
 *
 * Exported for unit testing.
 */
export function normalizeUsageDetails(usage: Record<string, unknown>): Record<string, number> {
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;

  const cacheRead =
    num(usage.prompt_cache_hit_tokens) ||
    num(usage.cache_read_input_tokens) ||
    num(promptDetails?.cached_tokens);
  const cacheWrite =
    num(usage.prompt_cache_write_tokens) ||
    num(usage.cache_creation_input_tokens);

  // 总输入（含缓存）：OpenAI/DeepSeek 取 prompt_tokens；
  // Anthropic 无 prompt_tokens，用 input_tokens(已排除 cache) 加回 cache_read + cache_write。
  const inputTokens = num(usage.input_tokens);
  const promptTokens = num(usage.prompt_tokens) || inputTokens + cacheRead + cacheWrite;
  const outputTokens = num(usage.completion_tokens) || num(usage.output_tokens);
  // 总 token：优先上游给的 total_tokens，否则 prompt + completion（prompt 已含缓存）。
  const totalTokens = num(usage.total_tokens) || promptTokens + outputTokens;

  // 未命中缓存的输入（分项之和 = total，不与 cache_* 重复计数）。
  const uncachedInput = Math.max(promptTokens - cacheRead - cacheWrite, 0);

  const out: Record<string, number> = {
    input: uncachedInput,
    output: outputTokens,
    total: totalTokens,
  };
  if (cacheRead > 0) out.cache_read_input_tokens = cacheRead;
  if (cacheWrite > 0) out.cache_creation_input_tokens = cacheWrite;
  return out;
}

/** 取数值字段（非数值按 0），与 ClickHouse 的 `num()` 口径一致。 */
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** 把任意值转为可写入 OTel 属性的字符串。 */
function asAttrString(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * 上报一次 LLM 调用：在指定 turn trace 下创建一个 generation observation，
 * 并把 trace 级属性写到该 span 上（SDK 会据此设置所属 trace 的字段）。
 *
 * 失败静默（仅 debug 日志），绝不影响业务请求。
 */
export function langfuseReportGeneration(report: LangfuseGenerationReport): void {
  if (!_enabled) return;

  try {
    const generation = startObservation(
      report.name,
      {
        model: report.model,
        input: report.input,
        output: report.output,
        usageDetails: report.usage ? normalizeUsageDetails(report.usage) : undefined,
        metadata: report.observationMetadata,
        level: report.level,
        statusMessage: report.statusMessage,
      },
      {
        asType: "generation",
        startTime: new Date(report.startTime),
        parentSpanContext: {
          traceId: report.traceId,
          spanId: deriveParentSpanId(report.traceId),
          traceFlags: TraceFlags.SAMPLED,
          isRemote: true,
        },
      },
    );

    // trace 级属性：直接写 OTel 属性，SDK 会传播到所属 trace。
    const span = generation.otelSpan;
    span.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, report.traceName);
    span.setAttribute(LangfuseOtelSpanAttributes.TRACE_USER_ID, report.userId);
    span.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, report.sessionId);
    if (report.tags && report.tags.length > 0) {
      span.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, JSON.stringify(report.tags));
    }
    // trace 级 input/output 与 observation 级解耦：仅在显式传入时写。
    // 首次人类输入请求传 traceInput（turn 最初的问题）；收尾请求传 traceOutput。
    if (report.traceInput !== undefined) {
      span.setAttribute(LangfuseOtelSpanAttributes.TRACE_INPUT, asAttrString(report.traceInput));
    }
    if (report.traceOutput !== undefined) {
      span.setAttribute(LangfuseOtelSpanAttributes.TRACE_OUTPUT, asAttrString(report.traceOutput));
    }
    if (report.traceMetadata) {
      span.setAttribute(
        LangfuseOtelSpanAttributes.TRACE_METADATA,
        JSON.stringify(report.traceMetadata),
      );
    }

    generation.end(new Date(report.endTime));
  } catch (err: unknown) {
    log.debug("langfuse.report_error", { error: String(err) });
  }
}

/** 一次失败请求的上报参数（上游错误 / 转发失败）。 */
export interface LangfuseFailureReport {
  /** turn 上下文。 */
  lf: LangfuseTurnContext;
  /** observation 名称（一般为模型名）。 */
  model: string;
  /** ISO 8601 开始时间。 */
  startTime: string;
  /** ISO 8601 结束时间。 */
  endTime: string;
  /** 该请求的输入 messages（用于排查）。 */
  input?: unknown;
  /** HTTP 状态码（转发异常时可缺省）。 */
  status?: number;
  /** 失败描述（如错误体片段或 "timeout/error"）。 */
  statusMessage: string;
  /** 额外标签（如 ["error"]）。 */
  extraTags?: string[];
  /** observation 级 metadata。 */
  observationMetadata?: Record<string, unknown>;
}

/**
 * 上报一次失败请求：在所属 turn trace 下创建一个 ERROR generation。
 * 不设 trace 级 input/output（失败不代表 turn 的最终结果），仅记录该次失败本身。
 */
export function langfuseReportFailure(report: LangfuseFailureReport): void {
  if (!_enabled) return;

  const { lf } = report;
  langfuseReportGeneration({
    traceId: lf.traceId,
    name: report.model,
    model: report.model,
    startTime: report.startTime,
    endTime: report.endTime,
    input: report.input,
    output: report.status !== undefined
      ? { error: true, status: report.status, message: report.statusMessage }
      : { error: true, message: report.statusMessage },
    level: "ERROR",
    statusMessage: report.statusMessage,
    traceName: lf.traceName,
    userId: lf.userId,
    sessionId: lf.sessionId,
    tags: report.extraTags && report.extraTags.length > 0 ? [...lf.tags, ...report.extraTags] : lf.tags,
    // trace 级 input 仍记录用户问题（便于在失败 trace 上看到原始诉求）；不写 output。
    traceInput: lf.userQuery || undefined,
    observationMetadata: {
      ...report.observationMetadata,
      ...(lf.routeTags.length > 0 ? { route: lf.routeTags } : {}),
    },
  });
}
