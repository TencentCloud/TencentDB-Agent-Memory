/**
 * chat_memory 资产 ID 生成规则。
 *
 * 约定：每个 (team, agent) 组合对应**一个**稳定的 chat_memory 资产，asset_id
 * 由 team_id 与 agent_id 拼出：
 *
 *     chat_memory-{team_id}-{agent_id}
 *
 * 这种确定性 ID 让写入路径自动幂等 —— 同一 (team, agent) 无论请求多少次，
 * 计算出的 asset_id 相同，store 层的主键约束会自然拦截重复插入。
 *
 * 正向拼接不需要反解。`/v3/chat-memory/clear` 需要从 asset_id 定位到
 * (team, agent) 才能清内容，但**不做字符串切分** —— team_id / agent_id 内部
 * 都可能含 `-`，切分会产生歧义。反向定位统一走 `resolveChatMemoryAgentId`：
 * 拿资产已知的 team_id + 候选 agent_id 正向拼接后比对，命中即确认。
 */

/** chat_memory 资产 ID 前缀。 */
export const CHAT_MEMORY_ASSET_PREFIX = "chat_memory-";

/** 稳定生成一个 (team, agent) 对应的 chat_memory 资产 ID。 */
export function buildChatMemoryAssetId(teamId: string, agentId: string): string {
  return `${CHAT_MEMORY_ASSET_PREFIX}${teamId}-${agentId}`;
}

/**
 * 在候选 agent 列表里找出与 assetId 匹配的那个 agent_id。
 *
 * 用正向拼接比对而非切分字符串，所以 team_id / agent_id 含 `-` 时依然正确。
 *
 * @param assetId    chat_memory 资产 ID
 * @param teamId     该资产记录上的 team_id（权威值，不从 assetId 里猜）
 * @param agentIds   该team 下的候选 agent_id 列表
 * @returns          命中的 agent_id；无匹配返回 undefined
 */
export function resolveChatMemoryAgentId(
  assetId: string,
  teamId: string,
  agentIds: Iterable<string>,
): string | undefined {
  for (const agentId of agentIds) {
    if (buildChatMemoryAssetId(teamId, agentId) === assetId) return agentId;
  }
  return undefined;
}
