/**
 * Supported-agents 事实源常量。
 *
 * 对应设计文档 docs/design/2026-08-25-instance-upstream-config.md §8.2。
 *
 * ## 定位
 *
 * Proxy 支持哪些 agent 由本文件的 `DEFAULT_SUPPORTED_AGENTS` 常量决定。它是:
 *   - Proxy 内部 handler 路由匹配的判据(见 server.ts 的 /:agent/:spaceId/... 段)
 *   - fixture / smoke / e2e 生成 request 时的 agent 白名单
 *   - Core `tdai-gateway.yaml` `upstream.supportedAgents` 段的**上游数据源**
 *
 * ## 与 Core yaml 的关系
 *
 * v2.4 起本常量**不再对外暴露 HTTP 接口**(§6.A 挂到 Core 了),Panel 请求 supported-agents
 * 走 Core 一条线。Core `tdai-gateway.yaml` 的 `upstream.supportedAgents` 段是本常量的
 * 运行时副本,发版前必须手动核对一致(暂无 CI/CD 校验)。
 *
 * ## 修改流程
 *
 * 新增或删除 agent 时,严格按以下顺序操作:
 *   1. 更新本常量(添加/删除 entry)
 *   2. 同步更新 `MemoryCore/tdai-gateway.standalone.yaml` 和 `tdai-gateway.service.yaml`
 *      的 `upstream.supportedAgents` 段
 *   3. 部署 Core → 部署 Proxy(顺序不能反,否则 Core seed default 组时会引用不存在的 agent)
 */

export type SupportedAgentProtocol = "anthropic" | "openai-chat" | "openai-responses";

export interface SupportedAgent {
  /** 内部枚举值,与 Proxy URL 路径首段一致(如 /codebuddy/:spaceId/...);数据库 agents 数组里存的就是这个 */
  agent_source: string;
  /** wire 协议;前端据此提醒用户"自定义 baseUrl 需兼容这个协议" */
  protocol: SupportedAgentProtocol;
  /** 前端展示用的可读名(中英文均可) */
  display_name: string;
}

/**
 * 当前 Proxy 部署支持的 agent 全集。
 *
 * ⚠️ 修改本常量后必须同步更新 Core yaml,详见文件头注释"修改流程"。
 */
export const DEFAULT_SUPPORTED_AGENTS: SupportedAgent[] = [
  { agent_source: "claude-code", protocol: "anthropic",        display_name: "Claude Code" },
  { agent_source: "codebuddy",   protocol: "openai-chat",      display_name: "CodeBuddy" },
  { agent_source: "codex",       protocol: "openai-responses", display_name: "Codex" },
  { agent_source: "workbuddy",   protocol: "openai-responses", display_name: "WorkBuddy" },
  { agent_source: "dsh",         protocol: "openai-chat",      display_name: "DeepSeek Harness" },
  { agent_source: "opencode",    protocol: "openai-chat",      display_name: "OpenCode" },
  // ── header-only 客户端(通过 x-team-id / x-agent-id / x-task-id 请求头预选身份,
  //    没有交互 form UI —— 客户端不认 proxy 伪造的 ask_followup_question tool_call,
  //    preset 失败/mismatch 场景必须 bypass 而非弹 form)。
  //    集合定义: src/session/preset.ts HEADER_ONLY_AGENTS
  //    消费点:  handler.ts / anthropicHandler.ts session-reset pre-hook,
  //             session/codebuddy/init.ts header-preselect 早退分支
  { agent_source: "pi",          protocol: "openai-chat",      display_name: "Pi" },
  { agent_source: "hermes",      protocol: "anthropic",        display_name: "Hermes" },
  { agent_source: "openclaw",    protocol: "anthropic",        display_name: "OpenClaw" },
];

/** O(1) 查表:agent_source → SupportedAgent。 */
const AGENT_MAP: ReadonlyMap<string, SupportedAgent> = new Map(
  DEFAULT_SUPPORTED_AGENTS.map((a) => [a.agent_source, a]),
);

/** 判断给定 agent_source 是否受支持(Proxy 路径首段是否合法)。 */
export function isSupportedAgent(agentSource: string | undefined | null): boolean {
  if (!agentSource) return false;
  return AGENT_MAP.has(agentSource);
}
