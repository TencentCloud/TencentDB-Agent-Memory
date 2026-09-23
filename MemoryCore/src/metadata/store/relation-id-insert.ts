/**
 * 关联表 `id` 列插入：碰撞检测与重试（配合 generateRelationId）。
 */
import { generateRelationId } from "../utils/id-generator.js";

export const RELATION_ID_RETRY_LIMIT = 3;

/** SQLite：关联表主键 `id` 唯一约束冲突。 */
export function isSqliteRelationIdCollision(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed: meta_\w+\.id\b/.test(msg);
}

/** MongoDB：关联表主键 `id` 重复键（E11000）。 */
export function isMongoRelationIdCollision(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  return e.code === 11000 && Boolean(e.keyPattern?.id);
}

/**
 * 使用自动生成的 relation id 执行插入；`fixedId` 已指定时不重试。
 *
 * 同步版本：`insert` 必须同步返回。若传入 async 回调，返回的 Promise 会在
 * try/catch 退出之后才 reject —— 碰撞检测被旁路、重试不发生（issue #1104）。
 * async 回调请用 `runWithGeneratedRelationIdAsync`。
 */
export function runWithGeneratedRelationId<T>(
  fixedId: string | undefined,
  isCollision: (err: unknown) => boolean,
  insert: (id: string) => T,
): T {
  if (fixedId) return insert(fixedId);
  let lastErr: unknown;
  for (let attempt = 0; attempt < RELATION_ID_RETRY_LIMIT; attempt++) {
    try {
      return insert(generateRelationId());
    } catch (err) {
      if (isCollision(err)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  if (lastErr instanceof Error) throw lastErr;
  throw new Error("relation id collision after max retries");
}

/**
 * `runWithGeneratedRelationId` 的 async 版本 —— 面向返回 Promise 的 insert
 * （MongoDB driver 的 insertOne/updateOne 等）。
 *
 * 同步版本无法用于 async 回调：`insert()` 一返回 Promise 就被 `return`，
 * 而真正的 `E11000` 要等 await 之后才 reject，此时 try/catch 早已退出，
 * `isCollision` 永不被求值、重试也永不发生（issue #1104）。这里把
 * `await` 放进 try 内，让 async rejection 走同一条碰撞重试路径。
 *
 * 语义与同步版本逐条对齐：fixedId 直通、碰撞重试至上限、非碰撞错误立即
 * 抛出、耗尽后原样抛出最后一次错误。
 */
export async function runWithGeneratedRelationIdAsync<T>(
  fixedId: string | undefined,
  isCollision: (err: unknown) => boolean,
  insert: (id: string) => Promise<T>,
): Promise<T> {
  if (fixedId) return insert(fixedId);
  let lastErr: unknown;
  for (let attempt = 0; attempt < RELATION_ID_RETRY_LIMIT; attempt++) {
    try {
      return await insert(generateRelationId());
    } catch (err) {
      if (isCollision(err)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  if (lastErr instanceof Error) throw lastErr;
  throw new Error("relation id collision after max retries");
}
