/**
 * stages/stream-finalize.ts —— stream tap 尾段的可复用小 helper 集合。
 *
 * 4 个 helper (对应 openai-chat + anthropic + codex + workbuddy 4 处 finalize):
 *   1. stageWriteUsageLog      — writeLog(event:"usage") + gate + try/catch
 *   2. stageRecordTokenUsage   — recordInputTokenUsage + custom+rateLimit gate
 *   3. stageEmitModelIntent    — emitModelIntentTelemetry + gate + fanout
 *   4. stageOpikStreamSpan     — opikUpdateTrace(main) + opikUpdateTrace(fork) + opikCreateLlmSpan
 *
 * 不做"一次巨型 stageStreamFinalize", 因为 4 runner 的 finalize:
 *   - Langfuse input formatter 各 protocol 不同 (buildLangfuseInputChat / buildLangfuseInput / codex+wb 各自)
 *   - assistantMessage 组装形态各不同 (openai role+content+tool_calls / anthropic content[] / responses type+content)
 *   - notifyUpstreamResponse toolCalls mapper 各不同 (openai/anthropic/wb 特色)
 * 这些留在 caller inline, 只抽"给相同参数产生相同副作用"的 4 段。
 *
 * 每个 helper 内部实现严格 preserving 老 handler 行为 + gate 语义:
 *   - opikGate / writeLogUsageGate / modelIntentTelemetryGate / rateLimitGate
 *   - 全部走 ctx.gates?.<name> !== false, 默认 undefined = 保留老行为 (跑)
 */

import type { ProxyConfig } from "../../types.js";
import { writeLog, type Pipeline } from "../../logger.js";
import { opikCreateLlmSpan, opikUpdateTrace } from "../../opik.js";
import { emitModelIntentTelemetry } from "../../session/model-intent-telemetry.js";
import { recordInputTokenUsage } from "../../rate-limit/guard.js";
import type { UsageProtocol } from "../../rate-limit/usage.js";
import type { StageGates } from "../strategies/agent/types.js";

// ── 1. usage log ────────────────────────────────────────────────────────────

export interface WriteUsageLogInput {
  config: ProxyConfig;
  gates?: StageGates;
  timestamp: string;
  modelId: string;
  keyId: string;
  sessionKey: string;
  turnSeq?: number;
  userInput?: string;
  upstreamUrl: string;
  usage: Record<string, unknown> | null | undefined;
  requestReceivedAt: string;
  extensionStats?: Record<string, unknown> | undefined;
  logMeta?: Record<string, unknown>;
  routedFrom?: string;
  spaceId?: string;
  upstreamRequestId?: string;
  pipe: Pipeline;
}

export function stageWriteUsageLog(input: WriteUsageLogInput): void {
  if (input.gates?.writeLogUsage === false) return;
  try {
    writeLog(input.config, {
      timestamp: input.timestamp,
      event: "usage",
      modelId: input.modelId,
      keyId: input.keyId,
      sessionKey: input.sessionKey,
      turnSeq: input.turnSeq,
      userInput: input.userInput,
      upstreamUrl: input.upstreamUrl,
      stream: true,
      // usage 缺失/null → 落空对象占位 (writeLog 要求必填; 老 handler 也
      // 一直这么兜底, UsageLogEntry.usage 下游只 spread, 空对象不会出错)。
      usage: input.usage ?? {},
      requestReceivedAt: input.requestReceivedAt,
      extensionStats: input.extensionStats,
      ...(input.logMeta ?? {}),
      routedFrom: input.routedFrom,
      spaceId: input.spaceId,
      upstreamRequestId: input.upstreamRequestId,
    });
  } catch (logErr: unknown) {
    input.pipe.error("LOG_WRITE", logErr);
  }
}

// ── 2. record input token usage ─────────────────────────────────────────────

export interface RecordTokenUsageInput {
  config: ProxyConfig;
  gates?: StageGates;
  isCustomUpstream: boolean;
  spaceId?: string;
  modelId: string;
  usage: Record<string, unknown>;
  protocol: UsageProtocol;
}

export async function stageRecordTokenUsage(input: RecordTokenUsageInput): Promise<void> {
  // custom upstream 不记 token 桶 (与 enforceRateLimit 对称)
  // rateLimit gate 关闭时同步跳过 (codex/wb bootstrap 状态)
  if (input.isCustomUpstream) return;
  if (input.gates?.rateLimit === false) return;
  await recordInputTokenUsage({
    config: input.config,
    instanceId: input.spaceId || undefined,
    modelId: input.modelId,
    usage: input.usage,
    protocol: input.protocol,
  });
}

// ── 3. emit model intent telemetry ──────────────────────────────────────────

export interface EmitModelIntentInput {
  gates?: StageGates;
  /** compositeKey 形态 "agentSource:sessionKey" (session_init_logs 对齐) */
  sessionKey: string;
  turnSeq?: number;
  spaceId?: string;
  userId: string;
  agentSource: string;
  intents: Array<{ name: string; arguments: string }>;
}

export function stageEmitModelIntent(input: EmitModelIntentInput): void {
  if (input.gates?.modelIntentTelemetry === false) return;
  if (input.intents.length === 0) return;
  try {
    emitModelIntentTelemetry({
      sessionKey: input.sessionKey,
      turnSeq: input.turnSeq,
      spaceId: input.spaceId,
      userId: input.userId,
      agentSource: input.agentSource,
      intents: input.intents,
    });
  } catch {
    // 埋点绝不阻塞业务
  }
}

// ── 4. opik update trace + create llm span ──────────────────────────────────

export interface OpikStreamSpanInput {
  config: ProxyConfig;
  gates?: StageGates;
  traceId: string;
  forkTraceId?: string;
  keyId: string;
  /**
   * Opik project of the turn trace this span belongs to. Must match the
   * project the trace was created in (e.g. the WeCom name), otherwise the
   * update and span land outside it. Defaults to `keyId`.
   */
  projectName?: string;
  modelId: string;
  startTime: string;
  endTime: string;
  inputMessages: unknown[];
  outputMessage: Record<string, unknown> | null;
  usage: Record<string, unknown>;
  retried: boolean;
  upstreamUrl: string;
  pipe: Pipeline;
  /**
   * openai-chat 特色: 完成 stream 后同时 update trace + create llm span 两步。
   * anthropic runner 只 create span (trace 由 caller 单独管理), 默认关闭。
   *
   * true = 走 updateTrace(main + fork) + createLlmSpan (openai-chat 老行为)
   * false = 只走 createLlmSpan (anthropic 老行为)
   */
  updateTrace?: boolean;
  /** custom stream tag 追加 (anthropic 没有 "stream" tag, 只在 retry 时加 "retry") */
  streamTag?: string;
}

export function stageOpikStreamSpan(input: OpikStreamSpanInput): void {
  if (input.gates?.opik === false) return;
  const outputMessages = input.outputMessage ? [input.outputMessage] : [];
  const projectName = input.projectName || input.keyId;
  try {
    if (input.updateTrace) {
      opikUpdateTrace(input.config, {
        traceId: input.traceId,
        projectName,
        endTime: input.endTime,
        output: outputMessages,
        usage: input.usage,
      });
      if (input.forkTraceId && !input.config.opik.stripRequestLogContent) {
        opikUpdateTrace(input.config, {
          traceId: input.forkTraceId,
          projectName: "request_log",
          endTime: input.endTime,
          output: outputMessages,
          usage: input.usage,
        });
      }
    }
    const tags: string[] = [];
    if (input.streamTag) tags.push(input.streamTag);
    if (input.retried) tags.push("retry");
    opikCreateLlmSpan(input.config, {
      traceId: input.traceId,
      projectName,
      name: input.modelId,
      startTime: input.startTime,
      endTime: input.endTime,
      inputMessages: input.inputMessages,
      outputMessage: input.outputMessage,
      model: input.modelId,
      usage: input.usage,
      tags: tags.length > 0 ? tags : undefined,
      forkProjectName: "request_log",
      forkTraceId: input.forkTraceId,
      forkMetadata: {
        keyId: input.keyId,
        modelId: input.modelId,
        stream: true,
        upstreamUrl: input.upstreamUrl,
      },
    });
  } catch (opikErr: unknown) {
    input.pipe.error("OPIK_SPAN", opikErr);
  }
}

// ── 5. once-finalizer（flush/cancel 双路径共用） ─────────────────────────────

/**
 * 把一段 finalize 逻辑包成幂等版本，供流式 TransformStream 的 `flush()` 与
 * `cancel()` 双路径共用。
 *
 * # 背景（2026-10-26 实抓）
 * OpenCode 等 SSE 客户端读到 `data: [DONE]` 就立即断开连接；当客户端断开
 * 赢得与上游 FIN 的竞态，运行时会 cancel 掉整条 pipeThrough 链，`flush()`
 * 永远不执行 —— 该轮的 L0 写入 / skill 触发 / credit 上报全部静默丢失
 * （write-l0 从不打印，hub 记忆为空）。openai-chat 的 tap 只有 flush 没有
 * cancel；anthropic 路径用独立 reader 循环消费上游，天然免疫。
 *
 * # 语义
 * - 第一次调用执行 finalize；后续调用（flush→cancel 交错、并发触发）直接返回
 * - finalize 抛错交给 onError 吞掉 —— flush/cancel 回调里绝不能二次抛异常
 * - 失败不重试（once 旗标在调用前置位）：与 L0 写入侧 withL0Retry 的重试语义
 *   分工明确，这里只保证「至多一次」
 */
export function createOnceFinalizer(
  finalize: () => Promise<void>,
  onError: (err: unknown) => void,
): () => Promise<void> {
  let finalized = false;
  return async (): Promise<void> => {
    if (finalized) return;
    finalized = true;
    try {
      await finalize();
    } catch (err: unknown) {
      onError(err);
    }
  };
}
