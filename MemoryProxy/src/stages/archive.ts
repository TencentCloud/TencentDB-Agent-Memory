/**
 * 归档阶段：统一 4 个 handler 的 buildArchiveCtx / triggerArchiveHooks / L0 写。
 *
 * 消息形状用 `protocol`（shape）参数区分：
 *   - "responses"：codex / workbuddy，assistant 消息为
 *     { type:"message", role:"assistant", content:[{type:"output_text", text}] }，
 *     user 文本走各自 adapter 的 extractUserText。
 *   - "anthropic"：assistant 消息为 { role:"assistant", content: text }，
 *     user 文本走 tdai/recorder.ts::extractLatestUserMessage。
 *   - "openai"：skill 直接使用 handler 传入的完整 assistant 消息（含 tool_calls），
 *     user 文本走 extractLatestUserMessage。
 *
 * L0 写三种模式（差异收敛）：
 *   - "track"：trackWrite + withL0Retry，fire-and-forget（stream 场景）；
 *   - "fire"：直接 .catch，不挂 in-flight set（anthropic 非流原行为）；
 *   - "await"：等待落盘（handler.ts 非流原行为）。
 */
import type { ProxyConfig } from "../types.js";
import type { AssetCapabilityFlags } from "../injection/types.js";
import { TdaiClient } from "../tdai/client.js";
import { deriveTdaiIdentity } from "../tdai/identity.js";
import type { TdaiIdentity, TdaiMessage } from "../tdai/types.js";
import { extractLatestUserMessage, recordTdaiTurn } from "../tdai/recorder.js";
import { trackWrite, withL0Retry } from "../tdai/pending-writes.js";
import { triggerSkillExtractIfReady } from "../skill/handler-glue.js";
import {
  isExtractionAllowed,
  isMemoryWriteAllowed,
  logExtractionSkipped,
} from "../extraction-gate.js";
import { recordSession } from "../common/session-stats.js";
import { codexAdapter } from "../agent-adapters/codex.js";
import { workbuddyAdapter } from "../agent-adapters/workbuddy.js";
import { getSessionStore, buildStoreSessionKey } from "../session/store.js";

/** 归档消息形状（协议）。 */
export type ArchiveProtocol = "responses" | "anthropic" | "openai";

/** L0 写入模式。 */
export type L0WriteMode = "track" | "fire" | "await";

/** 归档上下文：4 个 handler 的 archive ctx 差异收敛后的统一形态。 */
export interface ArchiveCtx {
  config: ProxyConfig;
  sessionKey: string;
  agentSource: string;
  sessionInfo: Record<string, unknown>;
  /** 原始对话输入：responses 是 body.input[]；chat/anthropic 是 body.messages[]。 */
  input: unknown[];
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  /** 从 input 抽出的最新用户提问（按 shape 提取）。 */
  tdaiUserMessage: TdaiMessage | null;
  /** thread 维度（threadIsolation 开启时 store 键带 :thread 后缀，fence 需要）。 */
  threadId?: string | null;
  assetCapabilities?: AssetCapabilityFlags;
}

/** buildArchiveCtx 输入。 */
export interface BuildArchiveCtxArgs {
  config: ProxyConfig;
  sessionInfo: Record<string, unknown> | null | undefined;
  injectionSkipped: boolean;
  input: unknown[];
  sessionKey: string;
  agentSource: string;
  protocol: ArchiveProtocol;
  userId?: string;
  callerUserKey?: string | null;
  spaceId?: string;
  threadId?: string | null;
  assetCapabilities?: AssetCapabilityFlags;
}

/**
 * 统一 TDAI L0 客户端工厂。
 * 原 4 个 handler 各自一份等价实现（handler/anthropic/codex 用
 * `config.tdai.` 直取，workbuddy 用 `config.tdai?.`），此处合并为一份，
 * 取两者的防御性并集。
 */
export function createTdaiClient(config: ProxyConfig, spaceId?: string): TdaiClient | null {
  if (!config.tdai?.enabled || !config.tdai?.memory?.enabled || !config.tdai?.endpoint) {
    return null;
  }
  return new TdaiClient({
    enabled: config.tdai.enabled && config.tdai.memory.enabled,
    endpoint: config.tdai.endpoint,
    apiKey: config.tdai.apiKey,
    serviceId: spaceId || config.tdai.serviceId,
    writeL0: config.tdai.memory.writeL0,
    recallL1: config.tdai.memory.recallL1,
    injectL2L3: config.tdai.memory.injectL2L3,
    l1Limit: config.tdai.memory.l1Limit,
    l2Limit: config.tdai.memory.l2Limit,
    recallCharBudget: config.tdai.memory.recallCharBudget,
    timeoutMs: config.tdai.memory.timeoutMs,
  });
}

/** 按 shape 提取最新用户消息（responses 走 agent adapter；chat/anthropic 走 recorder）。 */
export function extractArchiveUserMessage(
  input: unknown,
  protocol: ArchiveProtocol,
  agentSource: string,
): TdaiMessage | null {
  if (protocol !== "responses") {
    if (!Array.isArray(input)) return null;
    return extractLatestUserMessage(input as unknown[]);
  }
  if (agentSource === "workbuddy") {
    // 与 workbuddy 原提取逻辑一致（不做 trim）。
    const text = workbuddyAdapter.extractUserText(input);
    if (!text) return null;
    return { role: "user", content: text };
  }
  // codex（及未知 responses 客户端）：与原提取逻辑一致（trim）。
  const text = codexAdapter.extractUserText(input) ?? "";
  const trimmed = text.trim();
  if (!trimmed) return null;
  return { role: "user", content: trimmed };
}

/**
 * 统一归档上下文构造。
 * 原 codex/workbuddy 的 buildArchiveCtx 差异（tdai 工厂 / user 提取 / identity 来源）
 * 收敛到 protocol + agentSource 参数；chat/anthropic 原内联构造也并入。
 * 返回 null 表示跳过归档（injectionSkipped / session 未初始化）。
 */
export function buildArchiveCtx(args: BuildArchiveCtxArgs): ArchiveCtx | null {
  const { sessionInfo, injectionSkipped } = args;
  if (injectionSkipped || !sessionInfo) return null;

  const tdaiClient =
    args.assetCapabilities?.chat_memory === false
      ? null
      : createTdaiClient(args.config, args.spaceId);
  const tdaiIdentity = deriveTdaiIdentity({
    sessionInfo,
    userId: args.userId || null,
    sessionKey: args.sessionKey,
    userKey: args.callerUserKey ?? null,
    threadId: args.threadId ?? null,
  });
  const tdaiUserMessage = extractArchiveUserMessage(args.input, args.protocol, args.agentSource);

  return {
    config: args.config,
    sessionKey: args.sessionKey,
    agentSource: args.agentSource,
    sessionInfo,
    input: args.input,
    tdaiClient,
    tdaiIdentity,
    tdaiUserMessage,
    threadId: args.threadId ?? null,
    assetCapabilities: args.assetCapabilities,
  };
}

/** L0 写选项。 */
export interface L0WriteOptions {
  ctx: ArchiveCtx;
  /** 写入 L0 的 assistant 文本（handler 侧已按形状提取好）。 */
  assistantText: string;
  /**
   * 主对话门控（anthropic 的 requestKind==="main"；codex/workbuddy 恒 true）。
   * 是否卡 L0 由 l0MainDialogGate 决定。
   */
  mainDialog?: boolean;
  /**
   * L0 是否按 mainDialog 门控：anthropic true；handler/codex/workbuddy false
   * （handler 的 aux/headless 在 ctx 构造时就已置 null）。
   */
  l0MainDialogGate?: boolean;
  /** 会话 bypass（anthropic）；配合 config.tdai.memory.bypassWritePolicy 决定是否可写。 */
  bypassed?: boolean;
  l0Mode: L0WriteMode;
  /** L0 失败处理（codex/workbuddy 用 console.warn；anthropic/handler 用 pipe.error）。 */
  onL0Error?: (err: unknown) => void;
  /** bypass 写策略拦下时的自定义日志（anthropic 非流）；缺省走 logExtractionSkipped。 */
  onBypassSkip?: () => void;
  /** 非主对话跳过的路由日志；缺省静默。 */
  onDialogSkip?: (asset: "l0") => void;
}

/**
 * 统一 L0 写。
 * 门控与 4 个 handler 原分支对齐（tdaiClient 缺失静默 / extraction 关闭记
 * extraction.skipped / bypass 策略拦下走 onBypassSkip 或 skipped / 非主对话
 * 走 onDialogSkip）。
 */
export async function writeL0(opts: L0WriteOptions): Promise<void> {
  const { ctx, mainDialog = true, l0MainDialogGate = false, bypassed = false } = opts;
  if (l0MainDialogGate && !mainDialog) {
    opts.onDialogSkip?.("l0");
    return;
  }
  if (!ctx.tdaiClient) return;
  if (!isExtractionAllowed(ctx.config, "tdai-memory")) {
    logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKey);
    return;
  }
  if (bypassed && !isMemoryWriteAllowed(ctx.config, true)) {
    if (opts.onBypassSkip) {
      opts.onBypassSkip();
    } else {
      logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKey);
    }
    return;
  }
  // ── 写侧 fencing（纵深防御，第二道防线）──
  // 1) workbuddy 的会话状态机复用 codex：store 键实际在 `codex:` 前缀下，而
  //    ArchiveCtx.agentSource 是 `workbuddy` —— 按候选键扫描避免 fence 失效。
  // 2) 只比对 space（不做 userId / agentSource 比较）：auth userId 与 kernel
  //    user_id 语义不同；workbuddy 会话的 store agent 标签是 codex，比 agent 会误杀。
  // 3) 无绑定但 L1 有态 → 用 state 自带 space 兜底校验。
  // 4) threadIsolation 开启时 store 键带 `:thread` 后缀 → 有 threadId 时补查后缀键。
  const store = getSessionStore();
  const info = ctx.sessionInfo as { space_id?: string } | undefined;
  const siSpace = info?.space_id;
  // 候选键走单点约定 buildStoreSessionKey（workbuddy→codex 别名 + thread 后缀）。
  const keyBase = { agentSource: ctx.agentSource, sessionKey: ctx.sessionKey };
  const candidates: string[] = [];
  if (ctx.threadId) {
    candidates.push(
      buildStoreSessionKey({ ...keyBase, threadId: ctx.threadId, threadIsolation: true }),
    );
  }
  candidates.push(buildStoreSessionKey({ ...keyBase, threadIsolation: true }));
  if (ctx.agentSource === "workbuddy") {
    // 兼容历史上可能存在的 workbuddy: 前缀绑定
    candidates.push(`workbuddy:${ctx.sessionKey}`);
  }
  let drift = false;
  let found = false;
  let bindingChecked = false;
  for (const ck of candidates) {
    const b = store.getBoundIdentity(ck);
    const l1 = b ? undefined : store.get(ck);
    if (b || l1) {
      found = true;
      const storedSpace =
        b?.spaceId ??
        (l1 as { sessionInfo?: { space_id?: string } | null } | undefined)
          ?.sessionInfo?.space_id;
      if (siSpace && storedSpace && storedSpace !== siSpace) drift = true;
      break; // 首个命中的 store 键即该会话的真实归属键
    }
  }
  // 第二道防线跨实例兜底：L1（进程内）miss 时，用 binding repo（多节点共享）
  // 按 (spaceId, sessionId) 补查。binding 键本身按 space 命名空间化，能查到
  // 即代表写侧 space 与该绑定同域；查不到则计 fenceMiss（无绑定信息，不拦截）。
  if (!found) {
    const bindingRepo = store.getBindingRepo();
    if (bindingRepo) {
      bindingChecked = true;
      try {
        const binding = await bindingRepo.getBinding(siSpace ?? "", ctx.sessionKey);
        if (binding) found = true;
      } catch {
        /* binding 查询失败按无绑定信息处理，不阻断 L0（fail-open on unknown） */
      }
    }
  }
  if (drift) {
    console.warn(
      `[archive-fence] L0 skipped: session ownership drift ` +
        `(writeAgent=${ctx.agentSource} writeSpace=${siSpace ?? "-"} session=${ctx.sessionKey})`,
    );
    recordSession("fenceBlocked");
    return;
  }
  if (found) {
    recordSession("fenceAllowed");
  } else if (bindingChecked) {
    recordSession("fenceMiss");
  }

  const l0Promise = withL0Retry(() =>
    recordTdaiTurn(ctx.tdaiClient!, ctx.tdaiIdentity, ctx.tdaiUserMessage, opts.assistantText || null),
  );
  if (opts.l0Mode === "await") {
    await l0Promise;
  } else if (opts.l0Mode === "fire") {
    l0Promise.catch((err: unknown) => opts.onL0Error?.(err));
  } else {
    trackWrite(l0Promise.catch((err: unknown) => opts.onL0Error?.(err)));
  }
}

/** skill 归档选项。 */
export interface SkillArchiveOptions {
  ctx: ArchiveCtx;
  protocol: ArchiveProtocol;
  /** 无 assistantMessage 覆盖时按 shape 从 assistantText 组装。 */
  assistantText?: string;
  /** 完整 assistant 消息覆盖（anthropic 非流 / openai 用解析结果；null 表示无输出）。 */
  assistantMessage?: Record<string, unknown> | null;
  toolCallCountOverride?: number;
  /** 主对话门控；false 时跳过（走 onDialogSkip，缺省静默）。 */
  mainDialog?: boolean;
  onDialogSkip?: (asset: "skill") => void;
}

/** 按 shape 组装 skill 归档的 assistant 消息。 */
function buildSkillAssistantMessage(opts: SkillArchiveOptions): Record<string, unknown> | null {
  const text = opts.assistantText ?? "";
  if (opts.protocol === "responses") {
    return text
      ? {
          type: "message" as const,
          role: "assistant" as const,
          content: [{ type: "output_text" as const, text }],
        }
      : null;
  }
  if (opts.protocol === "anthropic") {
    return text ? { role: "assistant" as const, content: text } : null;
  }
  return null;
}

/** 统一 skill 归档触发。 */
export async function triggerSkill(opts: SkillArchiveOptions): Promise<void> {
  const { ctx, protocol, mainDialog = true } = opts;
  if (!mainDialog) {
    opts.onDialogSkip?.("skill");
    return;
  }
  if (!isExtractionAllowed(ctx.config, "skill")) {
    logExtractionSkipped(ctx.config, "skill", ctx.sessionKey);
    return;
  }
  const assistantMessage =
    opts.assistantMessage !== undefined
      ? opts.assistantMessage
      : buildSkillAssistantMessage(opts);
  await triggerSkillExtractIfReady({
    config: ctx.config,
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    sessionInfo: ctx.sessionInfo,
    inputMessages: ctx.input,
    assistantMessage,
    protocol,
    assetCapabilities: ctx.assetCapabilities,
    toolCallCountOverride: opts.toolCallCountOverride,
  });
}

/** L0 + skill 合并触发（codex/workbuddy 的流结束归档即此形态）。 */
export interface TriggerArchiveHooksOptions {
  ctx: ArchiveCtx;
  protocol: ArchiveProtocol;
  /** L0 写入的 assistant 文本。 */
  assistantText: string;
  /** skill 归档的 assistant 消息覆盖（无则按 protocol 从 assistantText 组装）。 */
  assistantMessage?: Record<string, unknown> | null;
  toolCallCountOverride?: number;
  mainDialog?: boolean;
  l0MainDialogGate?: boolean;
  bypassed?: boolean;
  l0Mode: L0WriteMode;
  onL0Error?: (err: unknown) => void;
  onBypassSkip?: () => void;
  /** 非主对话跳过归档的路由日志；缺省静默。 */
  onDialogSkip?: (asset: "l0" | "skill") => void;
}

export async function triggerArchiveHooks(opts: TriggerArchiveHooksOptions): Promise<void> {
  await writeL0({
    ctx: opts.ctx,
    assistantText: opts.assistantText,
    mainDialog: opts.mainDialog,
    l0MainDialogGate: opts.l0MainDialogGate,
    bypassed: opts.bypassed,
    l0Mode: opts.l0Mode,
    onL0Error: opts.onL0Error,
    onBypassSkip: opts.onBypassSkip,
    onDialogSkip: opts.onDialogSkip,
  });
  await triggerSkill({
    ctx: opts.ctx,
    protocol: opts.protocol,
    assistantText: opts.assistantText,
    assistantMessage: opts.assistantMessage,
    toolCallCountOverride: opts.toolCallCountOverride,
    mainDialog: opts.mainDialog,
    onDialogSkip: opts.onDialogSkip,
  });
}
