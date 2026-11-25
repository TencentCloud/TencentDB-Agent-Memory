/**
 * stages/injection.ts — 资产注入 stage (Phase 4)。
 *
 * 提取自 4 处 injection pipeline.process 调用:
 *   - handler.ts:1356-1388
 *   - anthropicHandler.ts:1260-1291
 *   - codexHandler.ts:888-980 (synthetic body 合成)
 *   - workbuddyHandler.ts:1681-1718 (synthetic body 合成)
 *
 * 本 stage 是薄包装, 委托给 injection/pipeline.ts 的现有 InjectionPipeline。
 * 差异 (blueprint §2.3):
 *   - openai 协议 (handler/CB/dsh/opencode): 直接注入到 messages[0]
 *   - anthropic (CC): 注入到 body.system
 *   - responses (codex/wb): 合成 synthetic body 组 input[0]
 *
 * 注入位置差异由 injection/adapters/*.ts (已存在) 处理, 本 stage 不重复。
 */

import type { InjectionPipeline } from "../../injection/pipeline.js";
import type { AgentContextMetadata } from "../../injection/types.js";

export interface InjectionStageInput {
  pipeline: InjectionPipeline;
  body: Record<string, unknown>;
  metadata: AgentContextMetadata;
  /** injection 被跳过的所有情况 (session bypassed / fork/sidequery / dsh headless / injectionSkipped=true) */
  skip: boolean;
}

export interface InjectionStageResult {
  /** 是否实际注入 (skip=true → false, 成功 → true) */
  applied: boolean;
  /** 注入后的 body; skip 或异常 → 原 body */
  body: Record<string, unknown>;
}

/**
 * 执行 injection stage — try/catch 内部降级, 出错也不阻塞主 pipeline。
 * blueprint §5.2: 静默 fallback 原 body。
 */
export async function stageInjection(input: InjectionStageInput): Promise<InjectionStageResult> {
  if (input.skip) {
    return { applied: false, body: input.body };
  }
  try {
    const injected = await input.pipeline.process(input.body, input.metadata);
    return { applied: true, body: injected };
  } catch (err) {
    console.warn(`[stage-injection] pipeline.process failed: ${(err as Error).message}`);
    return { applied: false, body: input.body };
  }
}
