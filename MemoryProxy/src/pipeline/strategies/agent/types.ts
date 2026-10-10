/**
 * AgentStrategy — 按客户端 (claude-code / codebuddy / codex / workbuddy / dsh /
 * opencode / pi / hermes / openclaw / default) 切分的策略接口。
 *
 * 扩展现有 `AgentAdapter` (agent-adapters/types.ts) 增加:
 *   - stage 门控 (StageGates + preset) —— 唯一被 pipeline 真实消费的部分
 *   - session-init 契约字段 (supportsSessionForm / bypassOnPresetFail, 契约预留)
 *
 * blueprint-review 决策:
 *   - 保持单接口 + 可选方法 (`?.()`) 方案 (§4 未采纳 mixin, 当前 agent 数够用)
 *   - 采纳 preset 模式 (§5) 降低 stageGates 组合复杂度
 *
 * addendum §4.3: `bypassOnPresetFail` 是 pi/hermes/openclaw 三方共用的
 * 硬约束, 不是可选特化。
 */

import type { AgentAdapter, AgentKind } from "../../../agent-adapters/types.js";

/**
 * 每个 stage 是否开启的独立门控 —— 本接口唯一被 pipeline 真实消费的部分。
 *
 * 当前状态 (2026-10-08): **所有 10 个 agent 均走 `full` preset**。
 *   - 原设计里 codex/workbuddy 从 `minimal` 起步、按 Phase 5 逐步 opt-in,
 *     但 handler-audit B1-B8 的 bug 修复代码在 minimal 下不生效 (部署后没效果),
 *     已改为与 CC/CB 一致的 full。
 *   - `minimal` / `observe-only` 两个 preset 保留作为调试/回滚档位, 当前无调用方。
 *   - direct/utility (passthrough/auxiliary) 走独立 runner, 不吃 stageGates。
 */
export interface StageGates {
  /** 模型是否在 pricing 表里 → 不在则 400 (阻断) */
  modelGate: boolean;
  /** identity/inspectAndRecord 埋点 */
  identityRecord: boolean;
  /** rate limit (enforceRateLimit + recordInputTokenUsage) */
  rateLimit: boolean;
  /** credit report (tryReportCreditFromPath + writeFailedReportRaw) */
  creditReport: boolean;
  /** opik trace + span 上报 */
  opik: boolean;
  /** writeLog(event:"usage") — stream/non-stream 完成后 CH usage 落表 */
  writeLogUsage: boolean;
  /** emitModelIntentTelemetry — tool_use 意图落 tool_call_logs 表 */
  modelIntentTelemetry: boolean;
  /** fetch 加 AbortSignal.timeout(config.forwardTimeoutMs) */
  forwardTimeout: boolean;
  /** cost-guard retryTarget 存在时二次转发 (含 anthropic sanitizeForRetry 钩子) */
  forwardRetry: boolean;
  /** systemUser 短路 (匹配到 systemUserId 直接 passthrough, 跳过 session/injection) */
  systemUser: boolean;
}

export type StagePreset = "full" | "minimal" | "observe-only";

export const STAGE_PRESETS: Record<StagePreset, StageGates> = {
  /**
   * handler.ts / anthropicHandler.ts 承载的现有行为完整版。
   * 切换到 pipeline 后必须保持完全等价, 一个 gate 都不能少。
   */
  full: {
    modelGate: true,
    identityRecord: true,
    rateLimit: true,
    creditReport: true,
    opik: true,
    writeLogUsage: true,
    modelIntentTelemetry: true,
    forwardTimeout: true,
    forwardRetry: true,
    systemUser: true,
  },
  /**
   * codex/workbuddy 初始版本 — 只走核心链路 (forward+stream), 不接观测/计费/限流。
   * 与迁移前 codex/wb handler 行为完全一致 (蓝图明确的"零回归"基线)。
   *
   * Phase 5 opt-in 时按 §5.1~5.8 逐个 flip 到 true, 每步独立 commit。
   */
  minimal: {
    modelGate: false,
    identityRecord: false,
    rateLimit: false,
    creditReport: false,
    opik: false,
    writeLogUsage: false,
    modelIntentTelemetry: false,
    forwardTimeout: false,
    forwardRetry: false,
    systemUser: false,
  },
  /**
   * observe-only — Phase 5 半程状态: 观测性 stage 都开, 但计费/限流仍关。
   * 用来先看数据流是否正常, 再决定 flip creditReport/rateLimit。
   */
  "observe-only": {
    modelGate: false,
    identityRecord: true,
    rateLimit: false,
    creditReport: false,
    opik: true,
    writeLogUsage: true,
    modelIntentTelemetry: true,
    forwardTimeout: false,
    forwardRetry: false,
    systemUser: false,
  },
};

/**
 * archive hook 的 wire protocol 标签。
 *
 * 注意: 它不是 AgentStrategy 上的字段 —— `stageArchive` 通过自己的
 * `ArchiveProtocol` 参数接收各 runner 传入的字面量。类型定义放这里是因为
 * stages/archive.ts 从这里 import。
 */
export type ArchiveProtocol = "anthropic" | "openai" | "responses";

/**
 * AgentStrategy — 扩展现有 AgentAdapter, 增加 stage 门控和客户端特化字段。
 *
 * 只有 `stageGates` 被 pipeline 真实消费 (runner 里 17 处 `_gates.<name>`)。
 * 其余字段分两类:
 *   - `supportsSessionForm` / `bypassOnPresetFail`: **契约预留**, 当前无消费点,
 *     见各字段 JSDoc。取值必须正确, 以便未来接线时语义已就位。
 *   - 已删除的死字段 (2026-10-08 清理): `archiveProtocol` / `buildFormResponse` /
 *     `detectClientCapabilities` / `detectDefaultGate` —— 这 4 个在 strategy 上
 *     零读取点, 真正生效的实现分别在:
 *       * archiveProtocol      → runner 传硬编码字面量给 stageArchive
 *       * buildFormResponse    → session/{codebuddy,claude-code,workbuddy,dsh,opencode}/form.ts
 *       * detectClientCapabilities → session/client-capabilities.ts
 *       * detectDefaultGate    → session/codebuddy/init.ts::detectCodexDefaultGate
 *     留着会在 strategy 里造出与实现不一致的第二份真相。
 */
export interface AgentStrategy extends AgentAdapter {
  /**
   * 是否弹 5-step form。false 表示 header-only 或 headless 客户端。
   *
   * ⚠️ 契约预留, 当前无消费点 —— 原消费点 `stages/session-init.ts` 已于
   * Round 18 被 `stages/session-init-orchestrate.ts` 取代并删除 (该编排 stage
   * 直接调 `handleSessionInit`, 不经此字段)。实际生效的 header-only / headless
   * 判断在 `session/codebuddy/init.ts` (按 `isHeaderOnlyAgent` Set 判 agentSource)
   * 与 runner 内联的 dshHeadless 分支。保留取值以维持 addendum §4.3 契约。
   */
  readonly supportsSessionForm: boolean;

  /**
   * addendum §4.3: pi/hermes/openclaw preset 失败任何场景都 bypass 不弹 form。
   * 只有 supportsSessionForm=false 的 header-only agent 才置 true。
   *
   * ⚠️ 契约预留, 当前无消费点 (同 `supportsSessionForm`, 原消费点
   * `stages/session-init.ts:70` 的两个 stage 已删)。实际生效的 bypass 在
   * `session/codebuddy/init.ts:835` 的 `isHeaderOnlyAgent(agentSource)` 分支。
   */
  readonly bypassOnPresetFail?: boolean;

  /** 每个 stage 的门控开关 —— 本接口唯一被 pipeline 真实消费的字段 */
  readonly stageGates: StageGates;
}

/**
 * 协议 × agent 合法组合白名单 (blueprint-review §6 采纳)。
 * pipeline/run.ts 入口处 assertValidCombo() 校验, 防 server.ts 60+ 条路由替换时组错。
 */
export const VALID_COMBOS: ReadonlySet<string> = new Set([
  "openai-chat:codebuddy",
  "openai-chat:dsh",
  "openai-chat:opencode",
  "openai-chat:pi",
  "openai-chat:unknown",
  "anthropic:claude-code",
  "responses:codex",
  "responses:workbuddy",
]);

export function assertValidCombo(
  protocolName: string,
  agentKind: AgentKind | null,
): void {
  if (!agentKind) return; // passthrough / utility 不绑 agent
  const key = `${protocolName}:${agentKind}`;
  if (!VALID_COMBOS.has(key)) {
    throw new Error(
      `Invalid protocol×agent combination: ${key}. Add to VALID_COMBOS if intentional.`,
    );
  }
}
