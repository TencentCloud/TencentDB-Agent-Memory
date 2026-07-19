/**
 * session-recall-cache.ts
 *
 * 吸收 PR #351 Erd-omg 的 injectedContentCache 设计：
 * Session 级别的 recall 结果缓存，按 sessionKey + query 做去重。
 *
 * 目的：同一 session 内的相同 recall query 无需重复请求 Gateway，
 * 减少网络开销的同时避免重复注入导致前缀变化。
 *
 * 线程安全：所有方法均为同步操作（Map 操作），不需要额外锁。
 */

import type { Logger } from "../core/types.js";

const TAG = "[memory-tdai] [session-cache]";

/** 缓存条目：recall 查询 → 注入文本 + 时间戳 */
interface CacheEntry {
  /** 注入到 prompt 中的完整 recall 文本 */
  injectedText: string;
  /** 插入时间 (epoch ms) */
  insertedAt: number;
}

export interface SessionRecallCacheOptions {
  /** TTL 毫秒，超时后条目失效。默认 60000 (1分钟) */
  ttlMs?: number;
  /** 最大缓存条目数。超出后按 LRU 淘汰。默认 100 */
  maxSize?: number;
  /** 可选 logger，用于记录 hit/miss 事件 */
  logger?: Logger;
}

/**
 * Session 级 Recall 缓存。
 *
 * 当 `recall.sessionRecallCache` 配置为 true 时，
 * 每轮对话前先检查缓存：同 session 同 query 直接返回缓存结果，
 * 避免重复注入相同内容 → 保护 prompt 前缀稳定性。
 */
export class SessionRecallCache {
  /** 主缓存：sessionKey → (cacheKey → CacheEntry) */
  private cache = new Map<string, Map<string, CacheEntry>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly logger?: Logger;

  constructor(opts: SessionRecallCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.maxSize = opts.maxSize ?? 100;
    this.logger = opts.logger;
  }

  /**
   * 生成缓存 key：sessionKey + query 的组合哈希
   * 同一 session 同一 query → 同 key → 命中缓存
   */
  private cacheKey(sessionKey: string, query: string): string {
    return `${sessionKey}::${query}`;
  }

  /**
   * 查询缓存。命中返回缓存的注入文本，未命中返回 null。
   */
  get(sessionKey: string, query: string): string | null {
    const sessionCache = this.cache.get(sessionKey);
    if (!sessionCache) return null;

    const entry = sessionCache.get(this.cacheKey(sessionKey, query));
    if (!entry) return null;

    // TTL 检查
    if (Date.now() - entry.insertedAt > this.ttlMs) {
      sessionCache.delete(this.cacheKey(sessionKey, query));
      this.logger?.debug?.(
        `${TAG} cache expired for session=${sessionKey}, query="${query.slice(0, 50)}"`,
      );
      return null;
    }

    this.logger?.debug?.(
      `${TAG} cache HIT: session=${sessionKey}, query="${query.slice(0, 50)}"`,
    );
    return entry.injectedText;
  }

  /**
   * 写入缓存。
   */
  set(sessionKey: string, query: string, injectedText: string, insertedAt?: number): void {
    if (!query || !injectedText) return; // 空查询不缓存

    let sessionCache = this.cache.get(sessionKey);
    if (!sessionCache) {
      sessionCache = new Map();
      this.cache.set(sessionKey, sessionCache);
    }

    // LRU 淘汰：超出 maxSize 时删除最旧的条目
    if (sessionCache.size >= this.maxSize) {
      const oldest = [...sessionCache.entries()].sort(
        (a, b) => a[1].insertedAt - b[1].insertedAt,
      )[0];
      if (oldest) {
        sessionCache.delete(oldest[0]);
        this.logger?.debug?.(`${TAG} LRU evicted: ${oldest[0]}`);
      }
    }

    sessionCache.set(this.cacheKey(sessionKey, query), {
      injectedText,
      insertedAt: insertedAt ?? Date.now(),
    });

    this.logger?.debug?.(
      `${TAG} cache SET: session=${sessionKey}, query="${query.slice(0, 50)}"`,
    );
  }

  /**
   * 清空指定 session 的所有缓存。
   * sessionKey 为空时清空全部。
   */
  clear(sessionKey?: string): void {
    if (sessionKey) {
      this.cache.delete(sessionKey);
    } else {
      this.cache.clear();
    }
    this.logger?.debug?.(`${TAG} cache cleared${sessionKey ? ` for ${sessionKey}` : " (all)"}`);
  }

  /**
   * 获取缓存统计信息。
   */
  stats(): { totalSessions: number; totalEntries: number } {
    let totalEntries = 0;
    for (const sessionCache of this.cache.values()) {
      totalEntries += sessionCache.size;
    }
    return {
      totalSessions: this.cache.size,
      totalEntries,
    };
  }

  /**
   * 关闭缓存，释放所有引用。
   */
  shutdown(): void {
    this.cache.clear();
    this.logger?.debug?.(`${TAG} shutdown`);
  }
}
