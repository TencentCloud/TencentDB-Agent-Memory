/**
 * SyncTarget —— 自动同步目标的判别联合。
 *
 * wiki 与 codegraph 共用同一个 AutoSyncScheduler。用判别联合而非继承/泛型：
 * 加新目标加一个成员，编译器强制所有 switch 分支处理它。
 *
 * key 带 kind 前缀（`code-graph:<id>` / `wiki:<id>`），天然不冲突 ——
 * 即使两类资源的 id 恰好相同也不会互相去重。
 */

import type { CodeGraphRow, WikiRow } from "./types.js";

export type SyncTargetKind = "code-graph" | "wiki";

export type SyncTarget =
  | { kind: "code-graph"; key: string; serviceId: string; teamId: string; id: string; row: CodeGraphRow }
  | { kind: "wiki"; key: string; serviceId: string; teamId: string; id: string; row: WikiRow };

/** 同步目标唯一键（带 kind 前缀，跨类型不冲突）。 */
export function targetKey(kind: SyncTargetKind, id: string): string {
  return `${kind}:${id}`;
}

export function toCodeGraphTarget(row: CodeGraphRow): SyncTarget {
  return {
    kind: "code-graph",
    key: targetKey("code-graph", row.code_graph_id),
    serviceId: row.service_id,
    teamId: row.team_id,
    id: row.code_graph_id,
    row,
  };
}

export function toWikiTarget(row: WikiRow): SyncTarget {
  return {
    kind: "wiki",
    key: targetKey("wiki", row.wiki_id),
    serviceId: row.service_id,
    teamId: row.team_id,
    id: row.wiki_id,
    row,
  };
}
