/**
 * WorkBuddy AgentStrategy。
 * 走 responses protocol; 独有 AskUserQuestion tool 检测 → 无则走 text-mode form。
 *
 * stageGates: full — 与 codex/CC/CB 观测能力对齐;
 * 修复了老 workbuddyHandler 的 handler-audit bug B1-B8 (与 codex 同款)。
 *
 * 2026-10-08 清理: 删去 strategy 上的 `archiveProtocol` / `detectClientCapabilities` /
 * `detectDefaultGate` —— 三者零读取点。真正生效的实现是
 * `session/client-capabilities.ts::detectClientCapabilities` (被
 * `runners/openai-chat.ts:679` 调用) 与 `session/codebuddy/init.ts::detectCodexDefaultGate`;
 * archive 的 protocol 由 runner 以字面量传给 stageArchive。
 */

import { workbuddyAdapter } from "../../../agent-adapters/workbuddy.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const workbuddyStrategy: AgentStrategy = {
  ...workbuddyAdapter,
  supportsSessionForm: true,
  stageGates: STAGE_PRESETS.full,
};
