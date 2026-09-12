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

import type { AgentAdapter, AgentKind } from "./types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codebuddyAdapter } from "./codebuddy.js";
import { codexAdapter } from "./codex.js";
import { workbuddyAdapter } from "./workbuddy.js";
import { dshAdapter } from "./dsh.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";
import { defaultAdapter } from "./default.js";

export type { AgentAdapter, AgentKind, RequestKind } from "./types.js";

/**
 * 已知客户端 kind（与下面 switch 的 case 一一对应）。
 *
 * 用途：上游能力探测的默认待探集合由此派生（`upstream/capability-probe.ts`），
 * 不再由探测模块自己维护一份客户端名单。
 *
 * ⚠️ 新增客户端时同步加进来。漏加的后果**不是编译错误**，而是该客户端默认不参与
 * 探测；但它只要有 `upstream.agents.<name>` 配置，仍会被探测并在启动期打
 * `upstream.probe.undeclared_protocol` 提示（见 capability-probe.ts）。
 *
 * 本批新增的 openclaw / hermes 先在这里登记：两个 adapter 文件随 #1325 / #1334 合入，
 * 与本支不在同一条直线上，所以本支 checkout 时它们解析为 default adapter（注册表完整性
 * 用例对"已登记但适配器未到"的 kind 只做白名单校验）。合入后由同一条用例强制两者声明
 * `nativeProtocols`，默认待探集合也随之自动包含它们。
 */
export type KnownAgentKind = AgentKind | "openclaw" | "hermes";

export const KNOWN_AGENT_KINDS: readonly KnownAgentKind[] = [
  "claude-code",
  "codebuddy",
  "codex",
  "workbuddy",
  "dsh",
  "opencode",
  "pi",
  // 适配器随后续 PR 合入（#1325 openclaw / #1334 hermes）；本支的 AgentKind 里还没有
  // 这两个名字，所以 KnownAgentKind 显式并上它们 —— 合入后这两个成员就是普通取值。
  "openclaw",
  "hermes",
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
    default:
      return defaultAdapter;
  }
}
