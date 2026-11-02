/**
 * opencode AgentStrategy (Phase 3)。
 * 走 openai-chat protocol, 恒 main, 弹 5-step form。
 */

import { opencodeAdapter } from "../../../agent-adapters/opencode.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const opencodeStrategy: AgentStrategy = {
  ...opencodeAdapter,
  supportsSessionForm: true,
  stageGates: STAGE_PRESETS.full,
};
