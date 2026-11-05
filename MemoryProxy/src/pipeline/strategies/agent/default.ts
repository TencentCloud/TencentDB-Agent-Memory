/**
 * Default (unknown) AgentStrategy (Phase 3)。
 * 保守兜底: 走 openai-chat, 弹 form, 所有 stage 开。
 */

import { defaultAdapter } from "../../../agent-adapters/default.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const defaultStrategy: AgentStrategy = {
  ...defaultAdapter,
  supportsSessionForm: true,
  stageGates: STAGE_PRESETS.full,
};
