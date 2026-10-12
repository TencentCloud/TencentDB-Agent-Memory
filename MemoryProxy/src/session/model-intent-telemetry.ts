/**
 * 模型意图 (tool_use) 埋点 helper —— handler.ts + anthropicHandler.ts 共用。
 *
 * 设计：SSE 流关流后，一次性把当轮 toolCallAccumulators 里所有 tool_use 转成
 *      kind='model_intent' 的埋点条目发出去。
 *
 * 硬约束（§7.-1）：
 *   - 同步返回 void，绝不 throw
 *   - sink 单条抛异常不影响其他条
 *   - 空 intents / 空 name 直接 skip
 */
import { writeToolCallRow, type ToolCallLogInput } from "../clickhouse.js";

/** 一个模型工具调用意图的最小描述。 */
export interface ModelIntent {
  /** function.name / tool_use.name */
  name: string;
  /** function.arguments / JSON.stringify(tool_use.input) —— 原文，未截断 */
  arguments: string;
}

export interface ModelIntentInput {
  sessionKey: string;
  turnSeq?: number;
  spaceId?: string;
  userId?: string;
  agentSource: string;
  intents: ModelIntent[];
}

/**
 * 一次性把当前 turn 累积的所有 tool_use 都发一条 model_intent 埋点。
 * 空数组或空 name 直接跳过；sink 单条异常不影响后续。
 */
export function emitModelIntentTelemetry(
  input: ModelIntentInput,
  sink: (row: ToolCallLogInput) => void = writeToolCallRow,
): void {
  try {
    if (!input.intents || input.intents.length === 0) return;
    const ts = new Date().toISOString();
    for (const intent of input.intents) {
      if (!intent || !intent.name) continue; // 空 name → partial SSE frame，跳过
      try {
        sink({
          timestamp: ts,
          sessionKey: input.sessionKey,
          turnSeq: input.turnSeq,
          spaceId: input.spaceId,
          userId: input.userId,
          agentSource: input.agentSource,
          kind: "model_intent",
          bridgeSource: "",
          initiatedTool: intent.name,
          executedEndpoint: "",
          requestBody: intent.arguments ?? "",
          upstreamStatus: 0,
          elapsedMs: 0,
        });
      } catch {
        // 单条失败 → 继续下一条；埋点绝不阻塞业务
      }
    }
  } catch {
    // 顶层兜底
  }
}
