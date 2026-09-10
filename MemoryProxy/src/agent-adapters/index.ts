/**
 * Agent Adapter 工厂。
 *
 * 根据 URL 前缀映射来的 `agentSource` 返回对应的适配器；未识别的客户端返回
 * default adapter（等价现状的保守行为）。
 *
 * 各点详见：
 *   - types.ts —— AgentAdapter 接口 + 三个适配点的说明
 *   - claude-code.ts —— CC 特化实现（当前唯一有源码/抓包依据的客户端）
 *   - codebuddy.ts —— CB stub（沿用 default 行为，等抓包再补 CB 特化）
 *   - default.ts —— unknown 兜底
 */

import type { AgentAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codebuddyAdapter } from "./codebuddy.js";
import { codexAdapter } from "./codex.js";
import { workbuddyAdapter } from "./workbuddy.js";
import { dshAdapter } from "./dsh.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";
import { hermesAdapter } from "./hermes.js";
import { defaultAdapter } from "./default.js";

export type { AgentAdapter, AgentKind, RequestKind } from "./types.js";

/**
 * 全部已知 agentSource 字符串（单一事实来源）。
 *
 * store 的 session key 形如 `${agentSource}:${sessionId}`（handler.ts 的
 * agentSource = URL 首段，openclaw 等经指纹识别后同名）。任何按
 * "裸 sessionId 反查带前缀 key"的消费者（memory-bridge / skill-bridge 的
 * L1 候选探测）都必须从这里取清单 —— 手写局部清单会随新 adapter 上线
 * 静默漏项（hermes 上线时漏过一次，bridge 全线 40101）。
 *
 * 新增 agentSource 时同步三处：
 *   1. resolveAgentAdapter 的 case（或 default 兜底）
 *   2. 本清单
 *   3. routes/whitelist.ts 的 AGENT_PREFIX_RE（仅 URL 前缀型 source）
 */
export const KNOWN_AGENT_SOURCES: readonly string[] = [
  "claude-code",
  "codebuddy",
  "codex",
  "cursor",
  "anthropic",
  "openai",
  "workbuddy",
  "dsh",
  "opencode",
  "pi",
  "hermes",
  "openclaw",
];

export function resolveAgentAdapter(agentSource: string): AgentAdapter {
  switch (agentSource) {
    case "claude-code":
      return claudeCodeAdapter;
    case "codebuddy":
      return codebuddyAdapter;
    case "codex":
      return codexAdapter;
    case "workbuddy":
      return workbuddyAdapter;
    case "dsh":
      return dshAdapter;
    case "opencode":
      return opencodeAdapter;
    case "pi":
      return piAdapter;
    case "hermes":
      return hermesAdapter;
    default:
      return defaultAdapter;
  }
}
