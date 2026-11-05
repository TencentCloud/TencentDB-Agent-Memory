/**
 * stages/prewarm-injection.ts — session-init 后 hook-cache prewarm 门 + 调用。
 *
 * 抽自 4 runner (openai-chat / anthropic / codex / workbuddy) 100% 同构的 prewarm
 * 门+调用块 (~30 行/runner):
 *   if (!bypassed && justRegistered && sessionInfo && !memCommandPending
 *       && injection.enabled && injectors.length > 0) {
 *     import injection; prewarmFromConfig({...}, { clearBefore: true });
 *   }
 *
 * 差异只在 logTag (每 runner 各自 warn 前缀) 和 callerUserKey 来源 (openai-chat
 * 用 apiKey, 其他 3 家用 callerUserKey), 由 caller 参数化传入。
 *
 * clearBefore:true 一直恒定 — 首次 init 缓存为空是 no-op, reset-flow 时清旧
 * agent 缓存必要, 统一语义更安全 (blueprint §5.1 red-line)。
 *
 * Fail-silent: prewarm 失败只 warn 不 throw, pipeline.ts 的 resolveHookBlocks
 * 有 cache-miss → execute() fallback 兜底。
 */

import type { ProxyConfig } from "../../types.js";
import type { SessionInfo } from "../../session/types.js";
import type { AssetCapabilityFlags } from "../../injection/types.js";

export interface PrewarmInjectionInput {
  /** session-init 结果的相关字段, 由 caller 从 initResult 里挑出来传 */
  bypassed: boolean;
  justRegistered: boolean;
  sessionInfo: unknown;
  agentDetail: unknown;
  taskDetail: unknown;
  /** mem 命令拦截 pending 时不 prewarm (mem 命令会改 session state, 提前 prewarm 会污染) */
  memCommandPending: boolean;

  config: ProxyConfig;
  sessionKey: string;
  userId: string | null;
  agentSource: string;
  spaceId?: string;
  assetCapabilities?: AssetCapabilityFlags;
  /** TDAI ACL 校验用 x-tdai-user-key; openai-chat 传 apiKey, 其他 3 家传 callerUserKey */
  callerUserKey?: string;
  /** warn 前缀, 各 runner 独有 ("[hook-cache] handler prewarm error" / "[codex] prewarm error" 等) */
  logTag: string;
}

export async function stagePrewarmInjection(input: PrewarmInjectionInput): Promise<void> {
  if (
    input.bypassed ||
    !input.justRegistered ||
    !input.sessionInfo ||
    input.memCommandPending ||
    !input.config.injection?.enabled ||
    (input.config.injection.injectors?.length ?? 0) === 0
  ) {
    return;
  }

  try {
    const mod = await import("../../injection/index.js");
    await mod.prewarmFromConfig(input.config, {
      keyId: input.sessionKey,
      userId: input.userId || "anonymous",
      agentSource: input.agentSource,
      spaceId: input.spaceId,
      sessionInfo: input.sessionInfo as SessionInfo,
      agentDetail: (input.agentDetail ?? null) as import("../../session/types.js").AgentDetail | null,
      taskDetail: (input.taskDetail ?? null) as import("../../session/types.js").TaskDetail | null,
      assetCapabilities: input.assetCapabilities,
      callerUserKey: input.callerUserKey,
    }, { clearBefore: true });
  } catch (err) {
    console.warn(input.logTag, err instanceof Error ? err.message : String(err));
    // Don't re-throw: pipeline.ts resolveHookBlocks 的 cache-miss → execute() fallback 兜底
  }
}
