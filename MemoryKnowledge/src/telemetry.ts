/**
 * OpenTelemetry + Langfuse span processor 初始化。
 *
 * The HTTP entrypoint initializes telemetry after configuration validation and
 * before serving requests. Importing this module does not initialize the SDK.
 *
 * AI SDK 的 generateText({ experimental_telemetry: { isEnabled: true } })
 * 会自动产生 GEN_AI 语义约定 span，LangfuseSpanProcessor 负责批量上报到 Langfuse。
 */

// Load environment configuration before explicit telemetry initialization.
import 'dotenv/config';

import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { trace, type Span } from "@opentelemetry/api";
import { createLogger } from "./logger.js";

const log = createLogger("telemetry");

let sdk: NodeSDK | null = null;

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
  process.on("SIGTERM", () => {
    sdk?.shutdown().catch(() => {});
  });
}

/** 优雅关闭 OpenTelemetry SDK。 */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    try {
      await sdk.shutdown();
    } catch {}
    sdk = null;
  }
}

/** 检查 Telemetry SDK 是否已初始化（用于回归测试）。 */
export function isTelemetryInitialized(): boolean {
  return sdk !== null;
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
