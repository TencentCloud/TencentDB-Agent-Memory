/**
 * username 安全化 —— 把任意 username 映射成**可安全用于文件名**的片段。
 *
 * 两个用途：
 *   1. 满足需求「SSH 相关文件名带 username」
 *   2. 防路径穿越：username 来自外部输入，绝不能直接拼进文件路径
 *
 * 纯函数、无 IO、无随机，便于单测。
 */

import { createHash } from "node:crypto";

/** 文件名允许字符集（与 KS 的 ID_SEGMENT_PATTERN 同源思路，额外放开 `.`）。 */
const SAFE_RE = /[^A-Za-z0-9_.-]/g;

/** 截断长度上限（文件名长度保护）。 */
const MAX_LEN = 64;

/** sanitize 后为空（如 username 全是非 ASCII）时的兜底名。 */
export const FALLBACK_USERNAME = "unknown";

/** username → 文件名安全片段。永不含 `/`、永不为 `..`、永不为空。 */
export function sanitizeUsername(username: string): string {
  const raw = (username ?? "").trim();
  const replaced = raw.replace(SAFE_RE, "_");
  const truncated = replaced.slice(0, MAX_LEN);
  // `.` 在允许字符集内（用于 alice.wang 这类名字），但纯点串（`..` / `.`）是
  // 路径穿越标记 —— 显式转成 `_`，让本函数无论被谁调用都安全。
  const dotsOnly = /^\.+$/.test(truncated);
  if (dotsOnly) return truncated.replace(/\./g, "_");
  return truncated || FALLBACK_USERNAME;
}

/**
 * sanitize 碰撞时的区分后缀：sha256(username) 前 8 位。
 *
 * 不同原始 username 可能 sanitize 出同一片段。用它做后缀可保证：
 *   - 同一 username → 永远同一把 key（稳定，不会每次变）
 *   - 不同 username → 永不串号
 */
export function collisionSuffix(username: string): string {
  return createHash("sha256").update(username, "utf8").digest("hex").slice(0, 8);
}

/**
 * 判定某个已存在的私钥文件是否属于该 username。
 *
 * 依据同目录的 `<basename>.owner` 标记文件内容。
 * 标记文件缺失时**视为不属于**（保守）：宁可换一个带后缀的文件名，
 * 也不能让 A 用户误用 B 用户的私钥。
 */
export function ownerMatches(ownerFileContent: string | null, username: string): boolean {
  if (ownerFileContent === null) return false;
  return ownerFileContent.trim() === username;
}
