/**
 * safe-path.ts — 落盘路径的边界校验。
 *
 * ingest 的落盘路径由 LLM 输出间接推导（FILE 块 path + frontmatter type），
 * 推导链上任何一环出错都可能产出逃出项目目录的相对路径。这里提供最后一道
 * 与推导逻辑无关的卡口：只认「解析成绝对路径后仍在 root 内」。
 */

import { resolve, sep } from "node:path";

/**
 * candidate 解析后是否仍落在 root 之内（root 自身算在内）。
 *
 * 比较前双方都过 resolve，因此 `..`、`.`、重复分隔符都已折叠；
 * 前缀比较额外带上分隔符，避免 `/data/proj-evil` 被判为在 `/data/proj` 内。
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep);
}
