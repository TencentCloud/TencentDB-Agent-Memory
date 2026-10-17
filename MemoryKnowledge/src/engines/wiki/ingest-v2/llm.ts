/**
 * llm.ts — OpenAI 兼容 chat 调用封装（wiki ingest 专用）。
 *
 * 复用仓库已有的 Vercel AI SDK（`ai` + `@ai-sdk/openai`），走标准
 * `/chat/completions`（compatibility: "compatible"），兼容各类 OpenAI 兼容后端。
 *
 * llmConfig 的实际形状由上层 module.ts 传入，字段命名为：
 *   { provider, apiKey, model, customEndpoint, maxContextSize }
 * 这里做归一化以兼容 INTERFACE 文档里写的 { baseUrl, maxTokens, timeoutMs } 别名。
 */

import { generateText, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createLogger } from "../../../logger.js";

const log = createLogger("wiki-ingest-llm");

/** 上层传入的原始 llmConfig（宽松，字段可能用不同命名）。 */
export interface RawLlmConfig {
  protocol?: "openai" | "anthropic";
  provider?: string;
  apiKey?: string;
  model?: string;
  // 实际命名（module.ts）
  customEndpoint?: string;
  maxContextSize?: number;
  // INTERFACE 文档别名
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * 是否用流式请求(streamText)调用上游。默认 false(非流式)。
   * 个别只接受流式请求的兼容上游需置 true。openai/anthropic 协议均生效。
   *
   * ⚠️ 仅 wiki-ingest 这条 AI SDK 直连路径生效;不影响 MemoryCore/OpenClaw host
   * runner。也不会把增量 token 透传给调用方,只是"以流式协议请求上游后等待
   * 完整文本"的兼容层。
   */
  stream?: boolean;
}

/** 归一化后的配置。 */
export interface NormalizedLlmConfig {
  protocol: "openai" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  stream: boolean;
}

const DEFAULT_MODEL = "Memory-Model";
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 1_200_000; // 20min — reasoning 模型需要更长时间

/**
 * 把上层多种命名的 config 归一化。
 *
 * 注意：这里**不再**兜底读 process.env（历史上读 TDAI_LLM_*，会绕过 resolveLlmConfig
 * 的 binding/mode 逻辑，造成"偷偷掉回直连"）。baseUrl/apiKey 必须由上层
 * （module.ts → resolveLlmConfig）提供；缺失时 createLlmClient 直接抛错。
 */
export function normalizeLlmConfig(raw: RawLlmConfig | undefined): NormalizedLlmConfig {
  const cfg = raw ?? {};
  const protocol = cfg.protocol ?? "openai";
  const baseUrl = cfg.baseUrl || cfg.customEndpoint || "";
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || DEFAULT_MODEL;
  const maxTokens = cfg.maxTokens ?? cfg.maxContextSize ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stream = cfg.stream ?? false;
  return { protocol, baseUrl, apiKey, model, maxTokens, timeoutMs, stream };
}

export interface ChatParams {
  system: string;
  prompt: string;
  /** 覆盖默认 max output tokens。 */
  maxOutputTokens?: number;
  /** 采样温度（可选，不传则用 SDK 默认）。 */
  temperature?: number;
  /** 外部 abort 信号（与内部超时合并）。 */
  abortSignal?: AbortSignal;
  /** 调用标签（如 "analysis"/"generate"/"merge"），用于日志区分步骤。 */
  label?: string;
}

/** 抽象出的最小 LLM 客户端接口，便于测试时打桩。 */
export interface LlmClient {
  chat(params: ChatParams): Promise<string>;
  readonly config: NormalizedLlmConfig;
}

/**
 * 基于 AI SDK 的真实客户端。纯文本输出（不挂任何 tool，避免弱模型幻觉 tool call）。
 */
export function createLlmClient(raw: RawLlmConfig | undefined): LlmClient {
  const config = normalizeLlmConfig(raw);
  if (!config.apiKey) {
    throw new Error(
      "LLM apiKey 未配置：proxy 模式需 TMC 为该 service_id 推送 llm_binding；" +
      "或设 LLM_MODE=custom + LLM_API_KEY 走自带端点",
    );
  }
  if (!config.baseUrl) {
    throw new Error(
      "LLM baseUrl 未配置：proxy 模式需 TMC 为该 service_id 推送 llm_binding；" +
      "或设 LLM_MODE=custom + LLM_BASE_URL 走自带端点",
    );
  }

  // 按 protocol 选 AI SDK provider 工厂（两者都实现 LanguageModelV3 接口）。
  const provider = config.protocol === "anthropic"
    ? createAnthropic({ baseURL: config.baseUrl, apiKey: config.apiKey })
    : createOpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey });

  return {
    config,
    async chat(params: ChatParams): Promise<string> {
      const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
      const signal = params.abortSignal
        ? AbortSignal.any([timeoutSignal, params.abortSignal])
        : timeoutSignal;

      const label = params.label ?? "chat";
      const promptChars = params.system.length + params.prompt.length;
      const startMs = Date.now();
      log.info(`LLM 调用开始 [${label}]`, {
        model: config.model,
        protocol: config.protocol,
        promptChars,
        maxOutputTokens: params.maxOutputTokens ?? config.maxTokens,
        timeoutMs: config.timeoutMs,
      });
      log.debug(`LLM system prompt [${label}] (model=${config.model})`, { text: params.system.slice(0, 200) });
      log.debug(`LLM user prompt [${label}] (model=${config.model})`, { text: params.prompt.slice(0, 500) });

      try {
        const callParams = {
          model: provider.chat(config.model),
          system: params.system,
          prompt: params.prompt,
          maxOutputTokens: params.maxOutputTokens ?? config.maxTokens,
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          abortSignal: signal,
          experimental_telemetry: {
            isEnabled: true,
            functionId: params.label ?? "chat",
          },
        };

        // stream=true → streamText(给只吃流式的上游);否则 generateText。
        // streamText 的 text/usage/finishReason 是 Promise,await 后形状与 generateText 一致。
        const { text, usage, finishReason } = config.stream
          ? await (async () => {
              const r = streamText(callParams);
              return {
                text: ((await r.text) ?? "").trim(),
                usage: await r.usage,
                finishReason: await r.finishReason,
              };
            })()
          : await (async () => {
              const r = await generateText(callParams);
              return {
                text: (r.text ?? "").trim(),
                usage: r.usage,
                finishReason: r.finishReason,
              };
            })();

        const u = usage ?? ({} as Record<string, number>);
        log.info(`LLM 调用完成 [${label}]`, {
          ms: Date.now() - startMs,
          promptTokens: u.inputTokens ?? null,
          completionTokens: u.outputTokens ?? null,
          totalTokens: u.totalTokens ?? null,
          finishReason: finishReason ?? null,
          outputChars: text.length,
        });
        if (!text) {
          log.warn(`LLM 返回空文本 [${label}]`, { finishReason: finishReason ?? null });
        }
        return text;
      } catch (err) {
        log.error(`LLM 调用失败 [${label}]`, {
          ms: Date.now() - startMs,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}
