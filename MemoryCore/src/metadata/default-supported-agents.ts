/**
 * Core 侧内置的 supported-agents fallback 常量。
 *
 * ## 定位
 *
 * 与 Proxy 侧的事实源 ``MemoryProxy/src/supported-agents.ts::DEFAULT_SUPPORTED_AGENTS``
 * **一一对应**,是 Core 部署时 yaml 未配置 ``upstream.supportedAgents`` 时的 fallback。
 *
 * ## 触发时机
 *
 * ``gateway/config.ts`` 里,`upstream.supportedAgents` yaml 段:
 *   - **有值**(非空数组):以 yaml 为准。用于运维**临时下线**某 agent 而不改代码
 *   - **无值 / 空数组**:自动使用本常量。Core 升级上线**无需**同步改 yaml,新 agent 只要
 *     改 Proxy 常量 + **同步**本 fallback 常量,即可端到端生效
 *
 * ## 与 Proxy 常量同步的要求
 *
 * 修改本常量 = 与 Proxy `DEFAULT_SUPPORTED_AGENTS` 同步。发版前手工核对(v2.5 决策),
 * 不一致时 v2.6 方案 E 的 diff-append 会把差异当作 "Proxy 上线新 agent" 处理 —— 老实例
 * default 会 diff-append 常量里有 Proxy 没有的 agent,行为不符预期。
 *
 * ## 与 yaml 混用的语义
 *
 * yaml 里配一个 agent(比如只留 claude-code)= 运维显式声明 "本 Core 只支持这些",
 * 即使 fallback 常量有 8 agent 也**不 fallback**。yaml 非空 = 完整覆盖,不是叠加。
 */

import type { SupportedAgent } from "./types.js";

/**
 * Core 侧 fallback 全集。与 Proxy `MemoryProxy/src/supported-agents.ts::DEFAULT_SUPPORTED_AGENTS` 完全对齐。
 *
 * ⚠️ 修改本常量后同步更新 Proxy 常量 + `tdai-gateway.standalone.yaml` / `service.yaml`
 * 里的 `upstream.supportedAgents`(可选,不改也 fallback 到本常量)。
 *
 * 新增 agent 上线 SOP:
 *   1. 改 Proxy `src/supported-agents.ts` 常量
 *   2. **改本文件常量**(fallback 保证 Core 部署即使忘更新 yaml 也能生效)
 *   3. 可选:改 `tdai-gateway.*.yaml`(运维想显式管理时才需要)
 *   4. 部署 Core → 部署 Proxy
 */
export const DEFAULT_SUPPORTED_AGENTS_FALLBACK: readonly SupportedAgent[] = Object.freeze([
  { agent_source: "claude-code", protocol: "anthropic",        display_name: "Claude Code" },
  { agent_source: "codebuddy",   protocol: "openai-chat",      display_name: "CodeBuddy" },
  { agent_source: "codex",       protocol: "openai-responses", display_name: "Codex" },
  { agent_source: "workbuddy",   protocol: "openai-responses", display_name: "WorkBuddy" },
  { agent_source: "dsh",         protocol: "openai-chat",      display_name: "DeepSeek Harness" },
  { agent_source: "opencode",    protocol: "openai-chat",      display_name: "OpenCode" },
  { agent_source: "pi",          protocol: "openai-chat",      display_name: "Pi" },
  { agent_source: "hermes",      protocol: "anthropic",        display_name: "Hermes" },
  { agent_source: "openclaw",    protocol: "anthropic",        display_name: "OpenClaw" },
]) as readonly SupportedAgent[];
