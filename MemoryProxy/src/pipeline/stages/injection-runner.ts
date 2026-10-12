/**
 * stages/injection-runner.ts — 主对话资产注入 stage。
 *
 * 提取自 openai-chat + anthropic runner 的 pipeline.process 调用块 (~30 行 × 2)。
 * codex/wb 的注入走独立的 synthetic body 合成路径, 不在此 stage 覆盖。
 *
 * 语义: try/catch 内部 silently 降级 (blueprint §5.2 red-line 2), 出错也不阻塞
 * 主 pipeline, fallback 原 body。
 */

import type { ProxyConfig } from "../../types.js";
import { countHumanTurns } from "../../turnSeq.js";
import type { AssetCapabilityFlags } from "../../injection/types.js";

export interface InjectionRunnerInput {
  /** injection 被跳过的所有 gate 汇总 (injectedSkipped, requestKind, etc.) */
  skip: boolean;
  config: ProxyConfig;
  body: Record<string, unknown>;
  protocol: "openai" | "anthropic";
  /** 主 pipeline turnSeq (未 monotonic 化, injection 只用 stateless 数) */
  messages: unknown[];
  traceId: string;
  keyId: string;
  modelId: string;
  isStream: boolean;
  agentSource: string;
  userId: string;
  spaceId: string;
  sessionKey: string;
  requestPath: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  assetCapabilities?: AssetCapabilityFlags;
  callerUserKey?: string;
  /** anthropic 独有: fork 请求 readOnly=true 不触发 self-heal */
  readOnly?: boolean;
}

export interface InjectionRunnerResult {
  /** 若注入成功替换; 未注入或失败 → 原 body */
  body: Record<string, unknown>;
  /** body.messages after (may equal input messages) */
  messages: unknown[];
}

/**
 * 执行 injection pipeline; 失败 silently fallback。
 */
export async function stageInjectionRunner(
  input: InjectionRunnerInput,
): Promise<InjectionRunnerResult> {
  const { skip, config, body, protocol, messages } = input;
  if (skip || !config.injection?.enabled || (config.injection?.injectors?.length ?? 0) === 0) {
    return { body, messages };
  }

  try {
    const injectionTurnSeq = countHumanTurns(messages, protocol);
    const { getInjectionPipeline } = await import("../../injection/index.js");
    const pipeline = getInjectionPipeline(config);
    const injectedBody = await pipeline.process(body, {
      protocol,
      traceId: input.traceId,
      keyId: input.keyId,
      modelId: input.modelId,
      stream: input.isStream,
      agentSource: input.agentSource,
      userId: input.userId || "anonymous",
      spaceId: input.spaceId,
      sessionKey: input.sessionKey,
      turnSeq: injectionTurnSeq,
      requestPath: input.requestPath,
      custom: input.sessionInfo
        ? {
            session: input.sessionInfo,
            assetCapabilities: input.assetCapabilities,
            userKey: input.callerUserKey || undefined,
          }
        : undefined,
      readOnly: input.readOnly,
    });
    const newMessages = Array.isArray(injectedBody.messages)
      ? injectedBody.messages as unknown[]
      : messages;
    return { body: injectedBody, messages: newMessages };
  } catch (err: unknown) {
    console.error(`[injection] ${protocol} pipeline error:`, err instanceof Error ? err.message : String(err));
    return { body, messages };
  }
}
