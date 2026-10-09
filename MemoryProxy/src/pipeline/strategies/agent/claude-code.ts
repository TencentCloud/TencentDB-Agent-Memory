/**
 * Claude Code AgentStrategy (Phase 3)。
 * 走 anthropic protocol，行为等价于 anthropicHandler.ts 现状。
 */

import { claudeCodeAdapter } from "../../../agent-adapters/claude-code.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const claudeCodeStrategy: AgentStrategy = {
  ...claudeCodeAdapter,
  supportsSessionForm: true,
  stageGates: STAGE_PRESETS.full, // 现有 handler 已经全开
};
