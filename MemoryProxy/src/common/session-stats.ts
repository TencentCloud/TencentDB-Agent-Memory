/**
 * 会话决策的轻量计数（进程内），用于观察会话的创建、续接与淘汰情况。
 */

export interface SessionStatsSnapshot {
  created: number;
  resumed: number;
  expired: number;
  windowEvicted: number;
  capEvicted: number;
  ghostRejected: number;
  /** auto- ID 在带 scope/首问指纹上下文中被拒（跨线程/跨窗口复用或伪造均计入）。 */
  scopeRejected: number;
  /** archive 写侧 fence 拦下的 L0 写入（归属漂移）。 */
  fenceBlocked: number;
  /** archive 写侧 fence 命中 store 记录且放行的次数（有效性分母）。 */
  fenceAllowed: number;
  /** fence 无绑定信息可校验（L1 miss 且 binding repo 无记录）——补全分母。 */
  fenceMiss: number;
}

const stats: SessionStatsSnapshot = {
  created: 0,
  resumed: 0,
  expired: 0,
  windowEvicted: 0,
  capEvicted: 0,
  ghostRejected: 0,
  scopeRejected: 0,
  fenceBlocked: 0,
  fenceAllowed: 0,
  fenceMiss: 0,
};

export type SessionStatKind = keyof SessionStatsSnapshot;

/** 按 agentSource / spaceId 的分解计数（会话决策归属可观测）。 */
const byAgent = new Map<string, SessionStatsSnapshot>();
const bySpace = new Map<string, SessionStatsSnapshot>();

function freshSnapshot(): SessionStatsSnapshot {
  return {
    created: 0,
    resumed: 0,
    expired: 0,
    windowEvicted: 0,
    capEvicted: 0,
    ghostRejected: 0,
    scopeRejected: 0,
    fenceBlocked: 0,
    fenceAllowed: 0,
    fenceMiss: 0,
  };
}

function bump(
  map: Map<string, SessionStatsSnapshot>,
  key: string,
  kind: SessionStatKind,
  n: number,
): void {
  let snap = map.get(key);
  if (!snap) {
    snap = freshSnapshot();
    map.set(key, snap);
  }
  snap[kind] += n;
}

export interface SessionStatMeta {
  agentSource?: string;
  spaceId?: string;
}

export function recordSession(
  kind: SessionStatKind,
  n = 1,
  meta?: SessionStatMeta,
): void {
  stats[kind] += n;
  if (meta?.agentSource) bump(byAgent, meta.agentSource, kind, n);
  if (meta?.spaceId) bump(bySpace, meta.spaceId, kind, n);
}

export function getSessionStats(): SessionStatsSnapshot {
  return { ...stats };
}

/** 按 agent / space 的会话决策分解（诊断端点用，不暴露具体会话 ID）。 */
export function getSessionStatsBreakdown(): {
  byAgent: Record<string, SessionStatsSnapshot>;
  bySpace: Record<string, SessionStatsSnapshot>;
} {
  return {
    byAgent: Object.fromEntries(byAgent),
    bySpace: Object.fromEntries(bySpace),
  };
}

export function resetSessionStats(): void {
  stats.created = 0;
  stats.resumed = 0;
  stats.expired = 0;
  stats.windowEvicted = 0;
  stats.capEvicted = 0;
  stats.ghostRejected = 0;
  stats.scopeRejected = 0;
  stats.fenceBlocked = 0;
  stats.fenceAllowed = 0;
  stats.fenceMiss = 0;
  byAgent.clear();
  bySpace.clear();
}

export function sessionStatsToPrometheus(): string {
  const lines: string[] = [];
  lines.push("# TYPE tdai_auto_session_created_total counter");
  lines.push(`tdai_auto_session_created_total ${stats.created}`);
  lines.push("# TYPE tdai_auto_session_resumed_total counter");
  lines.push(`tdai_auto_session_resumed_total ${stats.resumed}`);
  lines.push("# TYPE tdai_auto_session_expired_total counter");
  lines.push(`tdai_auto_session_expired_total ${stats.expired}`);
  lines.push("# TYPE tdai_auto_session_window_evicted_total counter");
  lines.push(`tdai_auto_session_window_evicted_total ${stats.windowEvicted}`);
  lines.push("# TYPE tdai_auto_session_cap_evicted_total counter");
  lines.push(`tdai_auto_session_cap_evicted_total ${stats.capEvicted}`);
  lines.push("# TYPE tdai_auto_session_ghost_rejected_total counter");
  lines.push(`tdai_auto_session_ghost_rejected_total ${stats.ghostRejected}`);
  lines.push("# TYPE tdai_auto_session_scope_rejected_total counter");
  lines.push(`tdai_auto_session_scope_rejected_total ${stats.scopeRejected}`);
  lines.push("# TYPE tdai_auto_session_fence_blocked_total counter");
  lines.push(`tdai_auto_session_fence_blocked_total ${stats.fenceBlocked}`);
  lines.push("# TYPE tdai_auto_session_fence_allowed_total counter");
  lines.push(`tdai_auto_session_fence_allowed_total ${stats.fenceAllowed}`);
  lines.push("# TYPE tdai_auto_session_fence_miss_total counter");
  lines.push(`tdai_auto_session_fence_miss_total ${stats.fenceMiss}`);
  const fenceEvaluated = stats.fenceBlocked + stats.fenceAllowed + stats.fenceMiss;
  const fenceCoverage = fenceEvaluated > 0
    ? (stats.fenceBlocked + stats.fenceAllowed) / fenceEvaluated
    : 0;
  lines.push("# TYPE tdai_auto_session_fence_coverage gauge");
  lines.push(`tdai_auto_session_fence_coverage ${fenceCoverage.toFixed(4)}`);
  const reuse =
    stats.created + stats.resumed > 0
      ? stats.resumed / (stats.created + stats.resumed)
      : 0;
  lines.push("# TYPE tdai_auto_session_reuse_rate gauge");
  lines.push(`tdai_auto_session_reuse_rate ${reuse.toFixed(4)}`);
  // per-space label 会随租户无限增长 → 只导出 created 最多的前 N 个，其余计 exceed，
  // 防指标基数爆炸（高基数治理）。
  const SPACE_LABEL_CAP = 32;
  for (const [agent, snap] of byAgent) {
    lines.push(`# TYPE tdai_auto_session_created_total_agent counter`);
    lines.push(`tdai_auto_session_created_total_agent{agent="${agent}"} ${snap.created}`);
  }
  const spaceEntries = [...bySpace.entries()].sort((a, b) => b[1].created - a[1].created);
  const keptSpaces = spaceEntries.slice(0, SPACE_LABEL_CAP);
  for (const [space, snap] of keptSpaces) {
    lines.push(`# TYPE tdai_auto_session_created_total_space counter`);
    lines.push(`tdai_auto_session_created_total_space{space="${space}"} ${snap.created}`);
  }
  if (spaceEntries.length > SPACE_LABEL_CAP) {
    lines.push(`tdai_auto_session_spaces_exceeded_total ${spaceEntries.length - SPACE_LABEL_CAP}`);
  }
  return lines.join("\n") + "\n";
}
