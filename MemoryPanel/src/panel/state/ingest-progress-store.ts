/**
 * Wiki ingest 细粒度进度（进程内存）。
 * KS → status-callback(event=ingest_progress) 写入；
 * wiki/get 聚合读出；终态 ready/failed 时 clear。
 *
 * B-2：带 run_id 代际 + TTL，避免「终态 clear 后迟到的 indexing/98」写回，
 * 导致下一轮 extracting/0 被单调规则丢弃、进度条卡在 98%。
 *
 * cleared 按 wiki 保留近期已清理的 runId 集合（非只记最后一个），
 * 防止：clear(run-1) → 写入 run-2 → 迟到的 run-1 被误判为「新代际」覆盖。
 */

export interface IngestProgress {
  phase: 'extracting' | 'merging' | 'indexing';
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  percent: number;
}

const PHASE_ORDER = { extracting: 0, merging: 1, indexing: 2 } as const;

/** 默认 30min；卡住的 processing 残留不会永久占坑。 */
export const DEFAULT_INGEST_PROGRESS_TTL_MS = 30 * 60 * 1000;

interface StoreEntry {
  runId: string | null;
  progress: IngestProgress;
  updatedAt: number;
}

export interface IngestProgressStoreOptions {
  ttlMs?: number;
  /** 可注入时钟，便于 TTL 单测 */
  now?: () => number;
}

export class IngestProgressStore {
  private readonly store = new Map<string, StoreEntry>();
  /** wikiId → (runId → clearedAt)；拒绝这些代际的迟到 progress */
  private readonly cleared = new Map<string, Map<string, number>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts?: IngestProgressStoreOptions) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_INGEST_PROGRESS_TTL_MS;
    this.now = opts?.now ?? Date.now;
  }

  /**
   * 单调更新：更高 phase 胜出；
   * 同 phase 时 percent 更高胜出；
   * percent 相同（取整撞车）则 completed+failed 更大胜出，避免计数停滞。
   *
   * runId：
   * - 落在已 clear 集合 → 丢弃（含跨代迟到包）；
   * - 与当前条目相同（或双方皆无）→ 套用单调规则；
   * - 与当前条目不同且非空 → 视为新一轮 ingest，直接覆盖。
   */
  update(wikiId: string, incoming: IngestProgress, runId?: string | null): void {
    const rid = normalizeRunId(runId);
    this.pruneCleared(wikiId);

    const clearedRuns = this.cleared.get(wikiId);
    if (clearedRuns && clearedRuns.size > 0) {
      if (rid && clearedRuns.has(rid)) return; // 已终态清理的代际迟到包
      if (!rid) {
        // 该 wiki 刚 clear 过：无 runId 的迟到包也丢弃，避免 clear 后再写回 98%
        return;
      }
    }

    const prev = this.store.get(wikiId);
    const ts = this.now();
    if (!prev || this.isExpired(prev)) {
      this.store.set(wikiId, { runId: rid, progress: incoming, updatedAt: ts });
      return;
    }

    // 新 runId → 允许从 extracting/0 重新开始（且该 rid 不在 cleared 集合）
    if (rid && prev.runId && rid !== prev.runId) {
      this.store.set(wikiId, { runId: rid, progress: incoming, updatedAt: ts });
      return;
    }
    // 当前无 runId、来包有 runId：视为新代际覆盖（升级路径）
    if (rid && !prev.runId) {
      this.store.set(wikiId, { runId: rid, progress: incoming, updatedAt: ts });
      return;
    }

    const prevOrder = PHASE_ORDER[prev.progress.phase];
    const inOrder = PHASE_ORDER[incoming.phase];
    if (inOrder > prevOrder) {
      this.store.set(wikiId, { runId: prev.runId ?? rid, progress: incoming, updatedAt: ts });
      return;
    }
    if (inOrder < prevOrder) return;
    if (incoming.percent > prev.progress.percent) {
      this.store.set(wikiId, { runId: prev.runId ?? rid, progress: incoming, updatedAt: ts });
      return;
    }
    if (incoming.percent < prev.progress.percent) return;
    const prevDone = prev.progress.completed + prev.progress.failed;
    const inDone = incoming.completed + incoming.failed;
    if (inDone > prevDone) {
      this.store.set(wikiId, { runId: prev.runId ?? rid, progress: incoming, updatedAt: ts });
    }
  }

  get(wikiId: string): IngestProgress | null {
    const entry = this.store.get(wikiId);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.store.delete(wikiId);
      return null;
    }
    return entry.progress;
  }

  /**
   * 终态清理。若提供 runId（或条目上已有），记入 cleared 集合，拒绝该代际迟到包。
   */
  clear(wikiId: string, runId?: string | null): void {
    const prev = this.store.get(wikiId);
    this.store.delete(wikiId);
    const rid = normalizeRunId(runId) ?? prev?.runId ?? null;
    if (rid) {
      let m = this.cleared.get(wikiId);
      if (!m) {
        m = new Map();
        this.cleared.set(wikiId, m);
      }
      m.set(rid, this.now());
    }
    this.pruneCleared(wikiId);
  }

  private isExpired(entry: StoreEntry): boolean {
    return this.now() - entry.updatedAt > this.ttlMs;
  }

  private pruneCleared(wikiId?: string): void {
    const cutoff = this.now() - this.ttlMs;
    const keys = wikiId ? [wikiId] : [...this.cleared.keys()];
    for (const id of keys) {
      const m = this.cleared.get(id);
      if (!m) continue;
      for (const [run, at] of m) {
        if (at < cutoff) m.delete(run);
      }
      if (m.size === 0) this.cleared.delete(id);
    }
  }
}

function normalizeRunId(runId: string | null | undefined): string | null {
  if (typeof runId !== 'string') return null;
  const t = runId.trim();
  return t.length > 0 ? t : null;
}
