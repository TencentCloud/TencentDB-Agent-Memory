/**
 * Bridge session-key 候选构造 —— memory-bridge / skill-bridge 共享。
 *
 * 注入文案里的 curl 模板只带裸 `x-conversation-id: <sessionId>`，而 store
 * 的 key 形如 `${agentSource}:${sessionId}`。L1 内存探测按候选前缀展开，
 * 清单**必须**来自 agent-adapters 的 KNOWN_AGENT_SOURCES 注册表 ——
 * 历史上这里手写了 `[bare, codebuddy:, claude-code:]` 三个，hermes 上线后
 * 全部 bridge 调用静默 40101（L2 拍平 binding 在 storage 未启用时也不存在）。
 *
 * 注意：L1 前缀探测只是同进程内存加速；跨前缀 / 跨重启的正解是 L2 拍平
 * binding（docs/design/2026-08-03-binding-flatten.md），它只吃
 * (spaceId, sessionId) 二元组、不依赖本清单。
 */
import { KNOWN_AGENT_SOURCES } from "../agent-adapters/index.js";

/**
 * 返回 L1 探测顺序：带 `:` 的调用方已给完整 key，原样单元素返回；
 * 裸 sessionId 先试原值，再展开全部已知 agentSource 前缀。
 */
export function buildSessionKeyCandidates(sessionId: string): string[] {
  if (sessionId.includes(":")) return [sessionId];
  return [sessionId, ...KNOWN_AGENT_SOURCES.map((s) => `${s}:${sessionId}`)];
}
