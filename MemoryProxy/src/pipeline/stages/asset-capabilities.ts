/**
 * stages/asset-capabilities.ts — session-init 后拉取 AssetCapabilityFlags 包装。
 *
 * 抽自 4 runner (openai-chat / anthropic / codex / workbuddy) 同构的:
 *   if (!bypassed && sessionInfo) {
 *     try { fetchAssetCapabilities(...); [log success] }
 *     catch { console.warn(...) }
 *   }
 *
 * 差异保留 (参数化):
 *   - callerUserKey 来源: openai-chat 用 apiKey, 其他 3 家用 callerUserKey
 *   - logSuccess: openai-chat / anthropic 走 [asset-capability] 成功日志,
 *     codex/wb 老代码没打 → 抽出后统一都打 (可观测性增强, 无回归风险)
 *   - warnPrefix: 各 runner 独立 (显式传参)
 */

import type { ProxyConfig } from "../../types.js";
import type { AssetCapabilityFlags } from "../../injection/types.js";

export interface AssetCapabilitiesInput {
  bypassed: boolean;
  sessionInfo: unknown;
  config: ProxyConfig;
  spaceId?: string;
  /** TDAI ACL x-tdai-user-key; openai-chat 传 apiKey||null, 其他传 callerUserKey */
  userKey: string | null | undefined;
  /** warn 前缀 (含冒号 + 空格前, 与老日志格式一致) */
  warnPrefix: string;
}

export async function stageAssetCapabilities(
  input: AssetCapabilitiesInput,
): Promise<AssetCapabilityFlags | undefined> {
  if (input.bypassed || !input.sessionInfo) return undefined;

  const userId = (input.sessionInfo as { user_id?: string }).user_id;
  try {
    const { fetchAssetCapabilities } = await import("../../tdai/capabilities.js");
    const flags = await fetchAssetCapabilities({
      endpoint: input.config.tdai.endpoint,
      apiKey: input.config.tdai.apiKey,
      serviceId: input.config.tdai.serviceId,
      serviceIdOverride: input.spaceId,
      userId,
      userKey: input.userKey ?? null,
      timeoutMs: input.config.tdai.memory.timeoutMs,
    });
    // Round 17b: 统一打成功日志 (openai-chat/anthropic 老代码打, codex/wb 老代码不打)
    console.log(`[asset-capability] user=${userId ?? "-"} flags=${JSON.stringify(flags)}`);
    return flags;
  } catch (err) {
    console.warn(input.warnPrefix, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}
