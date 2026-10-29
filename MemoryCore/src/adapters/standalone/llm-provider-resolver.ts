/**
 * 内核侧的 LLM provider 解析器 —— 不依赖 gateway 层，从纯 config + env 计算
 * 最终 (baseUrl, apiKey)。
 *
 * gateway 侧另有一个 llm-resolver.ts 做启动期校验；两者共享同一套字段语义：
 *   - provider="openai"：透传
 *   - provider="proxy"：baseUrl = `${baseUrl}/proxy/<iid>/v1`，
 *                       apiKey  = env.TDAI_MEMORY_SYSTEM_USER_KEY（sk-mem-xxx）
 *
 * 之所以再写一份而不直接 import gateway/llm-resolver：core/ 层不应反向依赖
 * gateway/；且 gateway 侧关心的是 GatewayMetadataConfig，而 core 侧只能拿到
 * process.env（gateway 启动时用 applyMetadataEnvFromGatewayConfig 回填）。
 */

import type { StandaloneLLMConfig } from "./llm-runner.js";
import type { LlmLayerName, LlmLayerOverride } from "../../config.js";

const MEMORY_USER_KEY_RE = /^sk-mem-[A-Za-z0-9_-]{32}$/;

export class LlmProviderResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmProviderResolveError";
  }
}

/**
 * 给定 core 侧的 llm 配置 + 当前 instanceId，计算实际发起 LLM 请求时的
 * (baseUrl, apiKey)。
 *
 * 输入的 llm 段应带上 provider / proxy 字段（gateway loader 已经填充；
 * OpenClaw 内嵌场景等价于 provider="openai" 走透传路径）。
 */
export function resolveStandaloneLlmForRuntime(
  llm: StandaloneLLMConfig,
  instanceId: string | undefined,
): StandaloneLLMConfig {
  const provider = llm.provider ?? "openai";
  if (provider !== "proxy") return llm;

  if (!llm.baseUrl) {
    throw new LlmProviderResolveError(
      "llm.provider=proxy 需要 llm.baseUrl 指向 context_proxy 根 URL",
    );
  }
  if (!instanceId || !instanceId.trim()) {
    throw new LlmProviderResolveError(
      "llm.provider=proxy 需要非空 instanceId，无法拼出 /proxy/<iid>/v1 路径",
    );
  }

  const useSystemUserKey = llm.proxy?.useMemorySystemUserKey ?? true;
  let effectiveApiKey = llm.apiKey;
  if (useSystemUserKey) {
    const envKey = process.env.TDAI_MEMORY_SYSTEM_USER_KEY?.trim();
    if (!envKey) {
      throw new LlmProviderResolveError(
        "llm.provider=proxy 需要 memory 系统用户 key —— " +
        "请在 yaml metadata.systemUser.memory 或 env TDAI_MEMORY_SYSTEM_USER_KEY 配置",
      );
    }
    if (!MEMORY_USER_KEY_RE.test(envKey)) {
      throw new LlmProviderResolveError(
        "memory 系统用户 key 必须匹配 sk-mem-[A-Za-z0-9_-]{32}",
      );
    }
    effectiveApiKey = envKey;
  }

  if (!effectiveApiKey) {
    throw new LlmProviderResolveError(
      "llm.provider=proxy 且 useMemorySystemUserKey=false 时必须显式 llm.apiKey",
    );
  }

  const cleanBase = llm.baseUrl.replace(/\/+$/, "");
  return {
    ...llm,
    baseUrl: `${cleanBase}/proxy/${encodeURIComponent(instanceId)}/v1`,
    apiKey: effectiveApiKey,
  };
}

/**
 * 把 `llm.layers.<layer>` 的覆盖叠加到已解析的 LLM 配置上。
 *
 * 为什么要分层：四个阶段的诉求相反——L1 提取必须在很小的预算里返回严格 JSON
 * （推理模型会把预算烧在思考上，响应被 max_tokens 截断），而 L2 场景合成 / L3
 * 画像是判断 + 综合任务，需要更大预算。只有全局 `llm.*` 时，调一层必伤另一层。
 *
 * 纯函数、无副作用：未配置 layers（或该层无覆盖）时原样返回，既有部署行为不变；
 * 未填写的字段回落到全局值。层名合法性由 config 解析期 fail-fast 保证。
 */
export function applyLlmLayerOverride(
  base: StandaloneLLMConfig,
  layer: LlmLayerName | undefined,
  layers: Partial<Record<LlmLayerName, LlmLayerOverride>> | undefined,
): StandaloneLLMConfig {
  if (!layer || !layers) return base;
  const override = layers[layer];
  if (!override) return base;
  return {
    ...base,
    ...(override.model ? { model: override.model } : {}),
    ...(override.maxTokens !== undefined ? { maxTokens: override.maxTokens } : {}),
    ...(override.timeoutMs !== undefined ? { timeoutMs: override.timeoutMs } : {}),
  };
}
