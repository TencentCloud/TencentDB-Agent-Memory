/**
 * ProxyStorage — 统一 KV 抽象，代替原本散落在注入层 / Skill 层的 Redis 直调。
 *
 * 见 docs/design/2026-07-09-redis-to-cos-migration-plan.md §3.
 *
 * 语义：
 *   - key 是相对路径字符串，如 "short/inj-sess/abc.json"。禁止绝对路径 / 路径穿越
 *   - putJSON/putText 覆盖写；写成功等价于"续期"（更新 lastModified，只对 ttl bucket 有意义）
 *   - putJSONIfAbsent/putTextIfAbsent CAS：仅当 key 不存在时写入，返回是否写成功
 *   - getJSON/getText 找不到返回 null，不抛
 *   - delPrefix 用于 clearBySession —— 后端各自实现
 *   - listNames 返回 prefix 下所有对象的 basename（不含 prefix）
 *
 * 所有方法 async；覆盖写可 fire-and-forget（`.catch(() => {})`）。
 * putIfAbsent 必须 await（返回值决定后续分支）。
 */
export type ProxyStorageType = "sqlite" | "fs" | "memory";

export interface ProxyStorage {
  readonly type: ProxyStorageType;

  putJSON(key: string, value: unknown): Promise<void>;
  putText(key: string, value: string): Promise<void>;

  /** 原子 "put if absent"。返回 true 表示本次成功写入；false 表示 key 已存在。 */
  putJSONIfAbsent(key: string, value: unknown): Promise<boolean>;
  putTextIfAbsent(key: string, value: string): Promise<boolean>;

  getJSON<T>(key: string): Promise<T | null>;
  getText(key: string): Promise<string | null>;
  exists(key: string): Promise<boolean>;

  del(key: string): Promise<void>;
  delPrefix(prefix: string): Promise<number>;

  listNames(prefix: string): Promise<string[]>;
}

/** 判断 key 属于哪档 bucket —— sweeper 与 lifecycle rule 生成器用。 */
export function bucketOf(key: string): "ttl" | "nottl" {
  return key.startsWith("ttl/") ? "ttl" : "nottl";
}
