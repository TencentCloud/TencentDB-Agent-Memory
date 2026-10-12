/**
 * Session-init 埋点装饰器（内部使用埋点 §7.2 Chunk 2 A/B）。
 *
 * 设计：不改 handleSessionInit 内部 30+ 个 `store.set(status:"initialized")` 点位，
 *      而是在**顶层入口的前后各读一次 state**，只在
 *      `prev !== "initialized" && after === "initialized"` 时发一条埋点。
 *
 * 硬约束（§7.-1）：
 *   - 同步返回 void，永远不抛
 *   - sink 内部异常静默吞掉
 *   - 无 state / 状态未变 / pending → pending 场景 no-op
 */
import type { SessionInitStatus } from "./types.js";
import type { SessionStore } from "./store.js";
import { writeSessionInitRow, type SessionInitLogInput } from "../clickhouse.js";

/** 埋点装饰器输入。sink 默认为真实的 writeSessionInitRow，可注入用于测试。 */
export interface EmitSessionInitTelemetryArgs {
  store: SessionStore;
  compositeKey: string;
  /** handleSessionInit 进入时的 store.get(...)?.status（如 undefined 传 "uninitialized"） */
  prevStatus: SessionInitStatus;
  /** "claude-code" | "codebuddy" */
  agentSource: string;
  /** 走 bypass 分支时从 log 抓的原文首句（可选） */
  bypassReason?: string;
  /** 测试注入点；默认调用 clickhouse.writeSessionInitRow */
  sink?: (input: SessionInitLogInput) => void;
}

/**
 * 若状态刚从非 initialized 迁移到 initialized，发一条 session_init 埋点。
 * 其他情况全部 no-op。
 */
export function emitSessionInitTelemetryIfCompleted(args: EmitSessionInitTelemetryArgs): void {
  try {
    if (args.prevStatus === "initialized") return; // steady state, nothing to emit
    const state = args.store.get(args.compositeKey);
    if (!state) return; // 未 set 过 → 例如 sessionKey=unknown
    if (state.status !== "initialized") return; // 中途 pending → 未完成

    const info = state.sessionInfo;
    const input: SessionInitLogInput = {
      timestamp: new Date().toISOString(),
      sessionKey: args.compositeKey,
      spaceId: info?.space_id,
      userId: info?.user_id,
      teamId: info?.team_id,
      agentId: info?.agent_id,
      agentSource: args.agentSource,
      bypassed: state.bypassed === true,
      bypassReason: args.bypassReason ?? "",
      finalStatus: "initialized",
    };
    const sink = args.sink ?? writeSessionInitRow;
    try {
      sink(input);
    } catch {
      // sink 抛异常 → 装饰器静默；埋点绝不阻塞业务
    }
  } catch {
    // 装饰器自身也不允许 throw
  }
}
