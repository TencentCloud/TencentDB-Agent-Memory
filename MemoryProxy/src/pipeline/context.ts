/**
 * PipelineContext — 请求生命周期内 stage 之间共享的显式状态。
 *
 * 设计原则 (采纳 blueprint-review §1 改良方案):
 *   - readonly 分区: 前 3 个 stage (auth / parse-body / classify) 后必须冻结
 *     的身份/请求字段, TS 编译器强制。
 *   - 可变分区: session-init / forward / stream 收尾等逐步填入的字段。
 *   - 目的: 防止后期 stage 无意间改掉早期已确定的值 (blueprint §3.1 red-line 8)。
 *
 * 每个 stage 的入参类型收窄成必要的子集 (Pick<PipelineContext, ...> 或
 * 阶段产出物 bundle), 编译器帮忙校验访问范围。
 *
 * 显式化的隐式 flag 参考 blueprint §5.1 (9 项) + addendum §5 (第 10 项 memoryTurn)。
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import type { LangfuseTurnContext } from "../langfuse.js";
import type { Pipeline } from "../logger.js";
import type { ForwardTarget } from "../guard-adapter.js";
import type { TdaiClient } from "../tdai/client.js";
import type { TdaiIdentity, TdaiMessage } from "../tdai/types.js";
import type { RequestKind } from "../agent-adapters/types.js";
import type { AssetCapabilityFlags } from "../injection/types.js";
import type { SessionInfo } from "../session/types.js";
export type { AssetCapabilityFlags };
export type { SessionInfo };

/**
 * PipelineContext — 请求全生命周期共享的状态。
 *
 * 使用姿势 (Phase 4 组装 runPipeline 时):
 *   - 上半区 readonly 字段在对应 stage 里通过 createContext / augmentXxx()
 *     初始化后不再改动。
 *   - 下半区可变字段由后续 stage 逐步填入。
 *   - 每个 stage 只依赖它需要的子集, 用 `Pick<PipelineContext, "keyA" | "keyB">`
 *     收窄入参; 或直接接阶段产出物 (auth / body / classify) 的 immutable bundle。
 */
export interface PipelineContext {
  // ── readonly 请求身份 (前 3 个 stage 之后冻结) ────────────────────────
  readonly c: Context;
  readonly config: ProxyConfig;
  readonly traceId: string;
  readonly startTime: string;
  readonly path: string;

  // ── Auth 阶段产出 ────────────────────────────────────────────────────
  readonly apiKey: string;
  readonly keyId: string;
  readonly userId: string;
  readonly spaceId: string;

  // ── Body 阶段产出 ────────────────────────────────────────────────────
  /** 完整请求 body (可能会被 injection/instance override 后续修改) */
  body: Record<string, unknown>;
  /** OpenAI: body.messages / Anthropic: body.messages / Responses: body.input */
  messages: unknown[];
  requestedModel: string;
  /** 经 alias 解析后的实际 model_id (Phase 1 后可能被 instance override 改) */
  modelId: string;
  isStream: boolean;
  hasTools: boolean;

  // ── 分类阶段产出 ─────────────────────────────────────────────────────
  readonly agentSource: string;
  requestKind: RequestKind;

  // ── Session-init 阶段产出 (blueprint §5.1 显式隐式 flag) ──────────────
  sessionKey: string;
  sessionInfo?: SessionInfo | null;
  sessionJustRegistered: boolean;
  injectionSkipped: boolean;
  assetCapabilities?: AssetCapabilityFlags;
  agentDetail?: unknown;
  taskDetail?: unknown;
  /** header-only agent (pi/hermes/openclaw) 语义 flag, addendum §5 第 10 项 */
  memoryTurn: boolean;
  /** mem 命令本 turn peek 到, prewarm 需短路 */
  memCommandPending: boolean;
  /** reset flow (mem:session-reset) 完成信息, 出 session-init 块后返回确认响应 */
  resetFlowResult?: unknown;

  // ── 特殊标记 (blueprint §5.1) ────────────────────────────────────────
  isCustomUpstream: boolean;
  skipCreditReport: boolean;
  isLegacyProxy: boolean;
  /** dsh headless (无 ask_user_question tool) 检测 → 跳过 session-init/injection */
  dshHeadless: boolean;

  // ── Forward 阶段产出 ─────────────────────────────────────────────────
  target?: ForwardTarget;
  effectiveApiKey: string;
  upstreamUrl: string;
  upstreamHeaders: Record<string, string>;

  // ── 响应阶段产出 ─────────────────────────────────────────────────────
  usage?: Record<string, unknown>;
  assistantText?: string;
  upstreamRequestId?: string;
  retried: boolean;

  // ── 观测性 ──────────────────────────────────────────────────────────
  pipe: Pipeline;
  lf: LangfuseTurnContext;
  turnSeq: number;
  debugMetadata?: unknown;

  // ── TDAI ────────────────────────────────────────────────────────────
  tdaiClient?: TdaiClient | null;
  tdaiIdentity?: TdaiIdentity;
  tdaiUserMessage?: TdaiMessage;
}

/**
 * 请求身份 bundle (auth + body + classify 后 immutable, 供后续 stage 引用)。
 * 用于 stage 函数入参收窄的 "partial context" 模式:
 *   stageSessionInitOrchestrate(req: RequestBundle, ...)
 *
 * blueprint-review §1 折中方案 —— readonly 分区 + 可变分区两个 bundle。
 */
export interface RequestBundle {
  readonly c: Context;
  readonly config: ProxyConfig;
  readonly traceId: string;
  readonly startTime: string;
  readonly path: string;
  readonly apiKey: string;
  readonly keyId: string;
  readonly userId: string;
  readonly spaceId: string;
  readonly agentSource: string;
  readonly requestKind: RequestKind;
  readonly requestedModel: string;
  readonly isStream: boolean;
  readonly hasTools: boolean;
}
