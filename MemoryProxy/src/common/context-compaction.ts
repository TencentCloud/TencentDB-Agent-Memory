/**
 * 上下文压缩（Context Offloading 最小版）——针对「Token 成本失控」。
 *
 * 长任务下客户端每轮都携带完整历史，单次成本可达普通对话数十倍。
 * 本模块在 **Proxy 转发上游前** 把早期轮次压缩：只保留最近 `keepRounds`
 * 轮原文（+ 工具闭环），更早的 user/assistant 轮替换为一行压缩标记。
 * 客户端侧上下文不受影响（它仍持有自己的历史），只降低上游 prompt token。
 *
 * 与「长上下文腐烂」的关系：压缩后有效上下文变小，关键信息依赖 L1 自动召回
 * 命中注入（而非堆在历史里），配合 `long-context-eval.mjs` 可量化召回率。
 */

export interface ContextCompactionConfig {
  enabled?: boolean;
  /** 保留最近 N 轮（一轮 = 一个 user 消息及其后的 assistant/tool）。默认 5。 */
  keepRounds?: number;
  /** 是否用摘要替代压缩标记（当前占位 false；后续可接 LLM 摘要）。 */
  summarize?: boolean;
}

export interface CompactedResult {
  messages: Array<Record<string, unknown>>;
  /** 被压缩掉的 user 轮数。 */
  droppedRounds: number;
  originalCount: number;
}

/**
 * 压缩 OpenAI Chat messages：保留 system + 最近 keepRounds 轮，
 * 更早轮次替换为一行压缩标记。纯函数、可测。
 */
export function compactMessages(
  messages: Array<Record<string, unknown>>,
  keepRounds = 5,
): CompactedResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, droppedRounds: 0, originalCount: messages?.length ?? 0 };
  }

  // system 消息必须始终保留（注入块 / 角色指令所在），不参与轮次压缩
  const systemMsgs = messages.filter((m) => m?.role === "system");
  const dialog = messages.filter((m) => m?.role !== "system");
  if (dialog.length === 0) {
    return { messages, droppedRounds: 0, originalCount: messages.length };
  }

  // 找每个 user 轮的开始索引
  const userIndexes: number[] = [];
  for (let i = 0; i < dialog.length; i++) {
    if (dialog[i]?.role === "user") userIndexes.push(i);
  }
  const userCount = userIndexes.length;
  if (userCount <= keepRounds) {
    return { messages, droppedRounds: 0, originalCount: messages.length };
  }

  const keepFrom = userIndexes[userCount - keepRounds];
  const dropped = userCount - keepRounds;
  const placeholder: Record<string, unknown> = {
    role: "user",
    content: `[早期对话已压缩 ${dropped} 轮。如需早期信息，请立即用 memory-bridge 检索（如 POST /memory-bridge/v3/atomic/search 或 /conversation/search），不要编造或猜测。当前保留最近 ${keepRounds} 轮。]`,
  };
  const kept = dialog.slice(keepFrom);
  // 压缩标记放在最前（保持 role 交替合法：system...user）
  return {
    messages: [...systemMsgs, placeholder, ...kept],
    droppedRounds: dropped,
    originalCount: messages.length,
  };
}
