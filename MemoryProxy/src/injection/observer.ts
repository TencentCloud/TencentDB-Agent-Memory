/**
 * InjectionObserver — 注入管线可观测性抽象。
 *
 * 设计目标：
 *   钩子开发者不需要写任何观测代码。管线在关键生命周期节点自动回调观察者，
 *   观察者实现（Noop/Logging）由管线构造时注入，永不阻断业务逻辑。
 *
 * 架构：
 *   InjectionPipeline → try/catch → InjectionObserver.onXxx() → log facade
 *
 * 原则：
 *   - Fire-and-forget：observer 内部可以异步，但不 await
 *   - 错误隔离：observer 的任何异常都不传播到管线
 *   - 默认 Noop：未配置时零开销
 */

import type { AgentContextMetadata, ContextBlock, InjectionHook, InjectionPoint } from "./types.js";
import { log } from "../report/log.js";
import { createHash } from "node:crypto";
import { TraceFlags } from "@opentelemetry/api";
import { startObservation, LangfuseOtelSpanAttributes } from "@langfuse/tracing";

// ── Hook execution result ─────────────────────────────────────────────────────

/** 单个钩子的执行结果汇总，由管线在 onPipelineEnd 时聚合上报。 */
export interface HookResult {
  hookId: string;
  point: InjectionPoint;
  blockCount: number;
  durationMs: number;
  error?: string;
  cacheStrategy?: string;
}

// ── Observer interface ────────────────────────────────────────────────────────

/**
 * 注入管线观察者接口。
 *
 * 管线在以下时机调用观察者方法：
 *   process() 入口     → onPipelineStart
 *   executeHooks 循环内 → onHookStart / onHookDone / onHookError（每个钩子）
 *   process() 出口     → onPipelineEnd（成功）或 onPipelineError（失败）
 *
 * 默认实现：NoopInjectionObserver（零开销）。
 * 生产实现：LoggingInjectionObserver（写入结构化日志）。
 */
export interface InjectionObserver {
  /** 管线开始处理一个请求。 */
  onPipelineStart(meta: AgentContextMetadata): void;

  /** 管线成功完成（所有钩子已执行）。 */
  onPipelineEnd(
    meta: AgentContextMetadata,
    durationMs: number,
    results: HookResult[],
  ): void;

  /** 管线级错误（如未知协议、适配器缺失），请求未能进入钩子执行阶段。 */
  onPipelineError(meta: AgentContextMetadata, error: Error): void;

  /** 单个钩子开始执行。 */
  onHookStart(hook: InjectionHook, point: InjectionPoint): void;

  /** 单个钩子执行完成（包括返回空 blocks 的情况）。 */
  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
  ): void;

  /** 单个钩子执行异常（会由 error start→error/done 记录）。 */
  onHookError(
    hook: InjectionHook,
    point: InjectionPoint,
    error: Error,
    durationMs: number,
  ): void;
}

// ── Noop implementation ───────────────────────────────────────────────────────

/**
 * 空操作观察者 —— 默认实现，零开销。
 * 所有方法均为空函数体，JIT 内联后无性能损耗。
 */
export class NoopInjectionObserver implements InjectionObserver {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onPipelineStart(_meta: AgentContextMetadata): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onPipelineEnd(_meta: AgentContextMetadata, _durationMs: number, _results: HookResult[]): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onPipelineError(_meta: AgentContextMetadata, _error: Error): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookStart(_hook: InjectionHook, _point: InjectionPoint): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookDone(_hook: InjectionHook, _point: InjectionPoint, _blocks: ContextBlock[], _durationMs: number, _cacheStrategy?: string): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookError(_hook: InjectionHook, _point: InjectionPoint, _error: Error, _durationMs: number): void { /* noop */ }
}

// ── Logging implementation ────────────────────────────────────────────────────

/**
 * 结构化日志观察者 —— 写入 `src/report/log.ts` 的结构化日志系统。
 *
 * 上报事件：
 *   injection.pipeline.start  — 管线开始
 *   injection.pipeline.done   — 管线完成（含 durationMs, hookCount, totalBlockCount）
 *   injection.pipeline.error  — 管线级错误
 *   injection.hook.start      — 单个钩子开始
 *   injection.hook.done       — 单个钩子完成（含 blocks 摘要）
 *   injection.hook.error      — 单个钩子失败
 *
 * 安全保证：所有方法内部 try/catch，绝不抛异常。
 */
export class LoggingInjectionObserver implements InjectionObserver {
  onPipelineStart(meta: AgentContextMetadata): void {
    try {
      log.info("injection.pipeline.start", {
        traceId: meta.traceId.slice(0, 8),
        protocol: meta.protocol,
        agentSource: meta.agentSource,
        modelId: meta.modelId,
      });
    } catch { /* observer must never throw */ }
  }

  onPipelineEnd(
    meta: AgentContextMetadata,
    durationMs: number,
    results: HookResult[],
  ): void {
    try {
      const totalBlockCount = results.reduce((sum, r) => sum + r.blockCount, 0);
      const errorCount = results.filter((r) => r.error).length;
      log.info("injection.pipeline.done", {
        traceId: meta.traceId.slice(0, 8),
        protocol: meta.protocol,
        agentSource: meta.agentSource,
        durationMs,
        hookCount: results.length,
        totalBlockCount,
        errorCount,
      });
    } catch { /* observer must never throw */ }
  }

  onPipelineError(meta: AgentContextMetadata, error: Error): void {
    try {
      log.error(
        "injection.pipeline.error",
        {
          traceId: meta.traceId.slice(0, 8),
          protocol: meta.protocol,
          agentSource: meta.agentSource,
          errorMsg: error.message,
        },
        error,
      );
    } catch { /* observer must never throw */ }
  }

  onHookStart(hook: InjectionHook, point: InjectionPoint): void {
    try {
      log.info("injection.hook.start", {
        hookId: hook.id,
        point,
        cacheStrategy: hook.cacheStrategy ?? "none",
        priority: hook.priority,
      });
    } catch { /* observer must never throw */ }
  }

  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
  ): void {
    try {
      const blockSummaries = blocks.map((b) => ({
        type: b.type,
        source: String(b.metadata?.source ?? "unknown"),
        preview: b.type === "text"
          ? b.content.replace(/\s+/g, " ").slice(0, 200)
          : `[${b.type}] ${b.metadata?.tool_name ?? ""}`,
      }));

      log.info("injection.hook.done", {
        hookId: hook.id,
        point,
        blockCount: blocks.length,
        durationMs,
        cacheStrategy: cacheStrategy ?? hook.cacheStrategy ?? "none",
        blocks: blockSummaries,
      });
    } catch { /* observer must never throw */ }
  }

  onHookError(
    hook: InjectionHook,
    point: InjectionPoint,
    error: Error,
    durationMs: number,
  ): void {
    try {
      log.warn("injection.hook.error", {
        hookId: hook.id,
        point,
        errorMsg: error.message,
        durationMs,
      });
    } catch { /* observer must never throw */ }
  }
}

// ── Langfuse implementation ───────────────────────────────────────────────────

/**
 * 确定性派生 Langfuse traceId（与 langfuse.ts 中 langfuseTurnTraceId 算法一致）。
 * 由 sessionKey + turnSeq 经 SHA-256 派生，取 hex 前 32 位。
 */
function deriveLangfuseTraceId(sessionKey: string, turnSeq: number): string {
  return createHash("sha256").update(`${sessionKey}:${turnSeq}`).digest("hex").slice(0, 32);
}

/** 派生 phantom parent spanId（与 langfuse.ts 中 deriveParentSpanId 一致）。 */
function deriveParentSpanId(traceId: string): string {
  return traceId.slice(0, 16);
}

/**
 * Langfuse 注入观察者 —— 将每个钩子的执行作为 span observation 挂到 Langfuse turn trace 下。
 *
 * 前提条件：metadata.sessionKey 和 metadata.turnSeq 必须存在，
 * 否则所有方法降级为 no-op（因为无法派生 Langfuse traceId）。
 *
 * 每个 hook 产生一条 span observation：
 *   - name: `[inject] {hookId}` 或 `[inject] {hookId} (error)`
 *   - metadata: hookId, point, cacheStrategy, durationMs, blockCount, blocks 摘要
 *   - traceId: 由 sessionKey + turnSeq 确定性派生（与上游 LLM generation 共享同一 trace）
 *
 * 安全保证：所有方法内部 try/catch，绝不抛异常；observer 不存在或降级时 fallback noop。
 */
export class LangfuseInjectionObserver implements InjectionObserver {
  /** 从 onPipelineStart 的 metadata 中捕获，后续 hook 回调使用。 */
  private meta: AgentContextMetadata | null = null;

  onPipelineStart(meta: AgentContextMetadata): void {
    try {
      this.meta = meta;
      // 无 span — 延迟到 hook 级别记录
    } catch { /* observer must never throw */ }
  }

  onPipelineEnd(
    _meta: AgentContextMetadata,
    _durationMs: number,
    _results: HookResult[],
  ): void {
    try {
      this.meta = null; // cleanup
    } catch { /* observer must never throw */ }
  }

  onPipelineError(_meta: AgentContextMetadata, _error: Error): void {
    try {
      this.meta = null;
    } catch { /* observer must never throw */ }
  }

  onHookStart(_hook: InjectionHook, _point: InjectionPoint): void {
    // span 在 onHookDone/onHookError 中一次性创建（含完整 duration）。
  }

  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
  ): void {
    try {
      const lfTraceId = this.getLangfuseTraceId();
      if (!lfTraceId) return;

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - durationMs);

      const blockSummaries = blocks.map((b) => ({
        type: b.type,
        source: String(b.metadata?.source ?? "unknown"),
        preview: b.type === "text"
          ? b.content.replace(/\s+/g, " ").slice(0, 300)
          : `[${b.type}] ${b.metadata?.tool_name ?? ""}`,
      }));

      // Name 格式：[inject] <hookId> @ <point> — 可在 Langfuse 按前缀/关键词搜索
      const name = blocks.length > 0
        ? `[inject] ${hook.id} @ ${point}`
        : `[inject] ${hook.id} @ ${point} (empty)`;

      const obsMeta: Record<string, unknown> = {
        hookId: hook.id,
        point,
        source: blocks[0]?.metadata?.source ?? "unknown",
        cacheStrategy: cacheStrategy ?? hook.cacheStrategy ?? "none",
        durationMs,
        blockCount: blocks.length,
        protocol: this.meta?.protocol ?? "unknown",
        agentSource: this.meta?.agentSource ?? "unknown",
      };
      // 实例维度：注入 span 与上游 generation 共享同一 turn trace，
      // 而 TRACE_METADATA 是 last-write-wins —— 不带 instanceId 会把它覆盖掉。
      // 注入 metadata 的 injection meta 字段（AgentContextMetadata.spaceId）
      // 内部保留 spaceId 名字；只有写进 Langfuse 的 key 改成 instanceId。
      if (this.meta?.spaceId) obsMeta.instanceId = this.meta.spaceId;

      const span = startObservation(
        name,
        {
          input: { point, cacheStrategy: cacheStrategy ?? hook.cacheStrategy ?? "none" },
          output: { blockCount: blocks.length, blocks: blockSummaries },
          metadata: obsMeta,
        },
        {
          asType: "span",
          startTime,
          parentSpanContext: {
            traceId: lfTraceId,
            spanId: deriveParentSpanId(lfTraceId),
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
          },
        },
      );

      // 观察级标注
      const otelSpan = span.otelSpan;
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.OBSERVATION_METADATA, JSON.stringify(obsMeta));
      // trace 级标注：叠加注入摘要（last-write-wins，所有 hook 都会写，最终保留最后一次的值）
      // instanceId 一并带上：trace metadata 会被注入 span 覆盖，漏了它实例维度就丢了。
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_METADATA, JSON.stringify({
        injection: { hookId: hook.id, point, blockCount: blocks.length, durationMs },
        ...(this.meta?.spaceId ? { instanceId: this.meta.spaceId } : {}),
      }));
      if (this.meta?.sessionKey) {
        otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, this.meta.sessionKey);
      }

      span.end(endTime);
    } catch { /* observer must never throw */ }
  }

  onHookError(
    hook: InjectionHook,
    point: InjectionPoint,
    error: Error,
    durationMs: number,
  ): void {
    try {
      const lfTraceId = this.getLangfuseTraceId();
      if (!lfTraceId) return;

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - durationMs);

      const obsMeta: Record<string, unknown> = {
        hookId: hook.id,
        point,
        errorMsg: error.message,
        durationMs,
        protocol: this.meta?.protocol ?? "unknown",
        agentSource: this.meta?.agentSource ?? "unknown",
      };
      if (this.meta?.spaceId) obsMeta.instanceId = this.meta.spaceId;

      const span = startObservation(
        `[inject] ${hook.id} @ ${point} (error)`,
        {
          input: { point, cacheStrategy: hook.cacheStrategy ?? "none" },
          output: { error: true, message: error.message },
          level: "ERROR",
          statusMessage: error.message,
          metadata: obsMeta,
        },
        {
          asType: "span",
          startTime,
          parentSpanContext: {
            traceId: lfTraceId,
            spanId: deriveParentSpanId(lfTraceId),
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
          },
        },
      );

      const otelSpan = span.otelSpan;
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.OBSERVATION_METADATA, JSON.stringify(obsMeta));
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.OBSERVATION_LEVEL, "ERROR");

      span.end(endTime);
    } catch { /* observer must never throw */ }
  }

  /** Derive Langfuse traceId from stored metadata, or null if unavailable. */
  private getLangfuseTraceId(): string | null {
    if (!this.meta?.sessionKey || this.meta.turnSeq === undefined) return null;
    return deriveLangfuseTraceId(this.meta.sessionKey, this.meta.turnSeq);
  }
}
