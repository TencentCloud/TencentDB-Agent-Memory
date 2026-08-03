/**
 * OpenTelemetry + Langfuse span processor 初始化。
 *
 * 在 server.ts 最顶部调用 initTelemetry()，确保在所有模块加载前
 * 注册 OTel SDK。未配置 LANGFUSE_SECRET_KEY 时静默跳过，不影响服务运行。
 *
 * AI SDK 的 generateText({ experimental_telemetry: { isEnabled: true } })
 * 会自动产生 GEN_AI 语义约定 span，LangfuseSpanProcessor 负责批量上报到 Langfuse。
 */

// 必须在读取 process.env 之前加载 .env，
// 因为 initTelemetry() 在 config.ts (含 import 'dotenv/config') 之前执行
import 'dotenv/config';

import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { trace, type Span } from "@opentelemetry/api";
import { createLogger } from "./logger.js";

const log = createLogger("telemetry");

let sdk: NodeSDK | null = null;

interface TelemetrySdk {
  shutdown(): Promise<void>;
}

/**
 * Build a one-shot SIGTERM handler that flushes telemetry before restoring the
 * signal's terminating behavior. The injected terminate hook keeps lifecycle
 * behavior deterministic in tests.
 */
export function createTelemetrySigtermHandler(
  telemetrySdk: TelemetrySdk,
  terminate: () => void = () => {
    process.kill(process.pid, "SIGTERM");
  },
): () => void {
  let shuttingDown = false;
  return () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void telemetrySdk.shutdown()
      .catch((err) => {
        log.warn("Langfuse telemetry shutdown failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(terminate);
  };
}

/** 初始化 OpenTelemetry + Langfuse。未配置 key 时静默跳过。 */
export function initTelemetry(): void {
  if (sdk) return; // 防止重复初始化

  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!secretKey) {
    log.info("Langfuse telemetry disabled (LANGFUSE_SECRET_KEY not set)");
    return;
  }

  try {
    sdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          shouldExportSpan: () => true,
        }),
      ],
    });
    sdk.start();
    log.info("Langfuse telemetry initialized", {
      baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
    });
  } catch (err) {
    log.warn("Langfuse telemetry init failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    sdk = null;
  }

  // 优雅退出时 flush 残留 span
  if (sdk) {
    process.once("SIGTERM", createTelemetrySigtermHandler(sdk));
  }
}

// ── Tracing helpers ──

/** 共享 tracer，供 ingest 流程创建 parent span。 */
export const tracer = trace.getTracer("knowledge-wiki");

/**
 * 在 span 上下文中执行异步函数。AI SDK 的 experimental_telemetry 会自动
 * 将 generateText 的 span 归并为当前 active span 的子 span。
 *
 * 用法：
 *   const result = await withSpan("wiki-ingest", async (span) => {
 *     span.setAttribute("wiki.name", name);
 *     return runIngest(...);
 *   });
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    // langfuse.name 属性让 Langfuse UI 显示 trace 标题
    span.setAttribute("langfuse.name", name);
    try {
      return await fn(span);
    } finally {
      span.end();
    }
  });
}
