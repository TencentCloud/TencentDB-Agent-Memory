/**
 * Bridge-side tool-call 埋点 helper（memory-bridge + skill-bridge 共用）。
 *
 * 设计：每次 upstream fetch 完成（成功或失败）都发一条 kind='bridge_call'。
 *      调用方负责把 body 脱敏到 <= 512 字节（本函数不再清洗），只做透传。
 *
 * 硬约束（§7.-1）：
 *   - 同步返回 void
 *   - sink 异常静默吞掉
 *   - body/sub 已由调用方准备好，绝不额外读 session store
 */
import { writeToolCallRow, type ToolCallLogInput } from "../clickhouse.js";

export interface BridgeCallTelemetryInput {
  sessionKey: string;
  turnSeq?: number;
  spaceId?: string;
  userId?: string;
  teamId?: string;
  agentId?: string;
  /** "claude-code" | "codebuddy" | "unknown" — 从 sessionKey 前缀反解 */
  agentSource: string;
  /** "memory-bridge" | "skill-bridge" */
  bridgeSource: string;
  /** 具体 sub 字符串（"atomic/search" / "skill/get" 等） */
  executedEndpoint: string;
  /** 已脱敏、已截断的 outbound body（<= 512 字节） */
  requestBody: string;
  /** upstream HTTP status（网络失败可传 0 或 502） */
  upstreamStatus: number;
  /** upstream 耗时毫秒 */
  elapsedMs: number;
  /**
   * 前置校验失败原因。空/未传 = 请求打到了上游（成功或 4xx/5xx）。
   * 非空 = proxy 前置早退，没到 fetcher。见 clickhouse.ts ToolCallLogInput 注释。
   */
  rejectReason?: string;
}

/**
 * 发一条 bridge_call 埋点。sink 默认走 clickhouse.writeToolCallRow。
 * 内部自吞异常，绝不 throw。
 */
export function emitBridgeToolCallTelemetry(
  input: BridgeCallTelemetryInput,
  sink: (row: ToolCallLogInput) => void = writeToolCallRow,
): void {
  try {
    const row: ToolCallLogInput = {
      timestamp: new Date().toISOString(),
      sessionKey: input.sessionKey,
      turnSeq: input.turnSeq,
      spaceId: input.spaceId,
      userId: input.userId,
      teamId: input.teamId,
      agentId: input.agentId,
      agentSource: input.agentSource,
      kind: "bridge_call",
      bridgeSource: input.bridgeSource,
      initiatedTool: "",
      executedEndpoint: input.executedEndpoint,
      requestBody: input.requestBody,
      upstreamStatus: input.upstreamStatus,
      elapsedMs: input.elapsedMs,
      rejectReason: input.rejectReason,
    };
    try {
      sink(row);
    } catch {
      // sink 抛 → 埋点绝不阻塞业务
    }
  } catch {
    // input 构造异常也吞掉
  }
}

/**
 * 从 proxy session-key 反解 agentSource。
 *   "claude-code:conv-abc" → "claude-code"
 *   "codebuddy:conv-abc"   → "codebuddy"
 *   "conv-abc"（无前缀）    → "unknown"
 */
export function agentSourceFromSessionKey(sessionKey: string): string {
  const idx = sessionKey.indexOf(":");
  if (idx <= 0) return "unknown";
  return sessionKey.slice(0, idx);
}

/**
 * 前置校验失败埋点 helper —— proxy 层拒绝了请求, 没能打到上游 fetcher。
 *
 * 前置早退大部分连 session ids 都还没解析出来 (missing header / bad content-type /
 * invalid json ...), 能拿到的稳定字段有限。剩下的字段按可选透传。
 *
 * 内部套 emitBridgeToolCallTelemetry, kind 仍是 'bridge_call', 通过 rejectReason
 * 非空来区分。老 dashboard 全部 kind='bridge_call' 的 SQL 一字不动仍能跑,
 * 新增维度靠 `WHERE reject_reason != ''` 反查。
 *
 * 硬约束: 同步返回 void, 埋点绝不阻塞业务; sessionKey 允许空串。
 */
export interface BridgeRejectTelemetryInput {
  /** derive 出来就填, 前置阶段 (missing header) 派生不了填 "" */
  sessionKey: string;
  bridgeSource: "memory-bridge" | "skill-bridge";
  /** 稳定枚举值, 供 GROUP BY —— 详见 tool_call_logs.reject_reason 注释 */
  rejectReason: string;
  /** proxy 返给客户端的 HTTP status (401/415/400/...); 存到 upstream_status 列 */
  httpStatus: number;
  /** subpath 若已能算出就填, 否则 "" */
  executedEndpoint?: string;
  /** body 若已解析可填 (调用方负责 <=512 截断), 否则 "" */
  requestBody?: string;
  spaceId?: string;
  userId?: string;
  teamId?: string;
  agentId?: string;
  agentSource?: string;
}

export function emitBridgeRejectTelemetry(input: BridgeRejectTelemetryInput): void {
  emitBridgeToolCallTelemetry({
    sessionKey: input.sessionKey,
    spaceId: input.spaceId,
    userId: input.userId,
    teamId: input.teamId,
    agentId: input.agentId,
    agentSource: input.agentSource
      ?? (input.sessionKey ? agentSourceFromSessionKey(input.sessionKey) : "unknown"),
    bridgeSource: input.bridgeSource,
    executedEndpoint: input.executedEndpoint ?? "",
    requestBody: input.requestBody ?? "",
    upstreamStatus: input.httpStatus,
    elapsedMs: 0,
    rejectReason: input.rejectReason,
  });
}
