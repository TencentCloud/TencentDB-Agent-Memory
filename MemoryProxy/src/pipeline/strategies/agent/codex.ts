/**
 * Codex AgentStrategy。
 * 走 responses protocol; Default-gate 检测在 session/codebuddy/init.ts (见下)。
 *
 * stageGates: full — 与 CC/CB 观测能力对齐;
 * 修复了老 codexHandler 的 handler-audit bug B1-B8 (rate limit / credit /
 * opik / identity / model gate / usage log / model intent 等观测和治理 stage)。
 * 部署后 CH tool_call_logs / Opik trace / identity 表都会开始有 codex 数据。
 *
 * 2026-10-08 清理: 删去 strategy 上的 `archiveProtocol` / `detectDefaultGate` ——
 * 两者零读取点。真正生效的 Default-gate 检测是
 * `session/codebuddy/init.ts::detectCodexDefaultGate` (611 行调用);
 * archive 的 protocol 由 runner 以字面量传给 stageArchive。
 */

import { codexAdapter } from "../../../agent-adapters/codex.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const codexStrategy: AgentStrategy = {
  ...codexAdapter,
  supportsSessionForm: true,
  stageGates: STAGE_PRESETS.full,
};
