/**
 * pi AgentStrategy (Phase 3)。
 *
 * addendum §4.3: pi 属 HEADER_ONLY_AGENTS, preset 失败任何场景都 bypass 不弹 form。
 */

import { piAdapter } from "../../../agent-adapters/pi.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const piStrategy: AgentStrategy = {
  ...piAdapter,
  supportsSessionForm: false, // header-only 客户端不认 ask_followup_question tool
  bypassOnPresetFail: true,
  stageGates: STAGE_PRESETS.full,
};
