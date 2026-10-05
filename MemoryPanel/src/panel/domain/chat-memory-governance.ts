/**
 * chat-memory-governance.ts —— chat_memory 资产专属的归属/共享数据模型。
 *
 * 跟 skill / wiki / code 不共用：每种资产的归属模型不同，硬抽象会绑架后续。
 *
 * 数据形状：
 *   每个 Agent 上挂一个 ChatMemoryAgentRel（共享开关 + 借入 ≤ 2）
 *
 * 持久化：
 *   后端 schema 还没落 chat_memory_rel 真字段；演示阶段把它塞进
 *   Agent.metadata_json 的 "chat_memory" namespace，与前端共用同一份契约。
 *   后端补字段后，把 readChatMemoryRel / writeChatMemoryRel 的实现切到真字段即可。
 */

/** 借入上限 —— chat_memory 专属。其他资产将来如有借入概念，自行定义。 */
export const MAX_IMPORTED_AGENTS = 2;

export interface ChatMemoryAgentRel {
  /** 自己的记忆是否对全 team 可见。本期 UI 锁定 true（"只要有就全局展示"）。 */
  memory_shared_with_team: boolean;
  /** 借入的 agent_id（≤ MAX_IMPORTED_AGENTS、必须同 team、不含自己、去重）。 */
  imported_agent_ids: string[];
}

export const DEFAULT_CHAT_MEMORY_REL: ChatMemoryAgentRel = {
  memory_shared_with_team: true,
  imported_agent_ids: [],
};

export type ValidateResult = { ok: true } | { ok: false; reason: string };

/** 校验 self 借入 ids 的规则；前端、后端共用。 */
export function validateImportedAgents(
  selfId: string,
  ids: string[],
  teamAgents: Array<{ agent_id: string }>,
): ValidateResult {
  if (!Array.isArray(ids)) return { ok: false, reason: 'imported_agent_ids must be an array' };
  if (ids.length > MAX_IMPORTED_AGENTS) {
    return { ok: false, reason: `at most ${MAX_IMPORTED_AGENTS} agents can be borrowed from` };
  }
  const teamSet = new Set(teamAgents.map((a) => a.agent_id));
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || typeof id !== 'string') return { ok: false, reason: 'contains an invalid agent_id' };
    if (id === selfId) return { ok: false, reason: 'an agent cannot borrow its own memory' };
    if (!teamSet.has(id)) return { ok: false, reason: `agent_id "${id}" is not in the current team` };
    if (seen.has(id)) return { ok: false, reason: 'duplicate agent in the borrow list' };
    seen.add(id);
  }
  return { ok: true };
}

const METADATA_NS = 'chat_memory';

interface AgentLike {
  agent_id: string;
  metadata_json?: string;
}

/** 从 Agent 读 chat_memory_rel；缺失时返回默认值。永不抛异常。 */
export function readChatMemoryRel(agent: AgentLike): ChatMemoryAgentRel {
  if (!agent.metadata_json) return { ...DEFAULT_CHAT_MEMORY_REL };
  try {
    const meta = JSON.parse(agent.metadata_json) as Record<string, unknown>;
    const slot = meta?.[METADATA_NS];
    if (slot && typeof slot === 'object') {
      return normalizeRel(slot as Partial<ChatMemoryAgentRel>);
    }
  } catch {
    /* 旧值不合法，走默认 */
  }
  return { ...DEFAULT_CHAT_MEMORY_REL };
}

/** 把 chat_memory_rel 合并写回 metadata_json，返回新的 JSON 字符串（不修改入参）。 */
export function writeChatMemoryRel(
  prevMetadataJson: string | undefined,
  rel: ChatMemoryAgentRel,
): string {
  let meta: Record<string, unknown> = {};
  if (prevMetadataJson) {
    try {
      const parsed = JSON.parse(prevMetadataJson);
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      /* 丢弃 */
    }
  }
  meta[METADATA_NS] = normalizeRel(rel);
  return JSON.stringify(meta);
}

function normalizeRel(input: Partial<ChatMemoryAgentRel>): ChatMemoryAgentRel {
  return {
    memory_shared_with_team:
      typeof input.memory_shared_with_team === 'boolean'
        ? input.memory_shared_with_team
        : DEFAULT_CHAT_MEMORY_REL.memory_shared_with_team,
    imported_agent_ids: Array.isArray(input.imported_agent_ids)
      ? Array.from(new Set(input.imported_agent_ids.filter((x) => typeof x === 'string'))).slice(
          0,
          MAX_IMPORTED_AGENTS,
        )
      : [],
  };
}
