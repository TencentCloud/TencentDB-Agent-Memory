/**
 * openclaw AgentStrategy (addendum §4.3 契约补齐)。
 *
 * 与 hermes 完全对称 —— addendum 原文把两者并列在 `HEADER_ONLY_AGENTS` 里
 * (session/preset.ts:32-36), `isHeaderOnlyAgent()` 对二者行为一致:
 *   > - `hermes`   — anthropic, no ask-user tool available
 *   > - `openclaw` — anthropic, same as hermes
 *
 * 补齐原因、协议、行为、以及"契约完善而非行为修复"的说明均同 hermes.ts,
 * 详见该文件头注释。
 * 独立成文件 (而非复用 hermes 实例) 是为了保持与其余 agent 一致的结构 ——
 * 未来任一方做抓包特化时不会牵连另一方。
 */

import { defaultAdapter } from "../../../agent-adapters/default.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const openclawStrategy: AgentStrategy = {
  ...defaultAdapter,
  agentKind: "openclaw",      // 覆盖 defaultAdapter 的 "unknown"
  supportsSessionForm: false, // header-only 客户端不认 proxy 伪造的 form tool_call
  bypassOnPresetFail: true,   // preset 失败任何场景一律 bypass, 绝不弹 form
  stageGates: STAGE_PRESETS.full,
};
