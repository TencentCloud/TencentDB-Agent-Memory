/**
 * CodeBuddy AgentStrategy (Phase 3)。
 * 走 openai-chat protocol, 恒 main, 弹 5-step form。
 */

import { codebuddyAdapter } from "../../../agent-adapters/codebuddy.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const codebuddyStrategy: AgentStrategy = {
  ...codebuddyAdapter,
  supportsSessionForm: true,
  stageGates: STAGE_PRESETS.full,
};
