/**
 * dsh (deepseek-harness) AgentStrategy (Phase 3)。
 * 走 openai-chat protocol; headless (无 ask_user_question tool) 时跳过 session-init。
 */

import { dshAdapter } from "../../../agent-adapters/dsh.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const dshStrategy: AgentStrategy = {
  ...dshAdapter,
  supportsSessionForm: true, // 有 ask_user_question 时才弹; headless 判断在 runner 内联
  stageGates: STAGE_PRESETS.full,
};
