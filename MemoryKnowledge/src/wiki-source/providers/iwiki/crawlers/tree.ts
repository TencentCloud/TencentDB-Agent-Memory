/**
 * 遍历策略之一：走平台**层级接口**展开目录树（父 → 子）。
 *
 * 适用：平台提供"取某节点直接子级"的接口（iWiki 的 getSpacePageTree）。
 * 特点：结构完整；但接口是逐层的，大空间递归次数多、耗时长。
 */

import type { RemotePageRef, SourceContext } from "../../../types.js";
import { getSpacePageTree, type IWikiTreeNode } from "../mcp-client.js";

/** 递归深度上限，防异常数据无限展开。 */
const MAX_DEPTH = 20;

/**
 * 递归展开整棵树（BFS），返回扁平列表。
 *
 * 保留目录标记：has_children=true 的节点为目录（不可单独导入）。
 */
export async function crawlTree(
  ctx: SourceContext,
  roots: IWikiTreeNode[],
): Promise<RemotePageRef[]> {
  const out: RemotePageRef[] = [];
  const visited = new Set<number>();

  interface Todo {
    nodes: IWikiTreeNode[];
    parentId: number | null;
    parentPath: string;
    depth: number;
  }
  const queue: Todo[] = [{ nodes: roots, parentId: null, parentPath: "", depth: 0 }];

  while (queue.length > 0) {
    const { nodes, parentId, parentPath, depth } = queue.shift()!;
    if (depth > MAX_DEPTH) continue;

    for (const node of nodes) {
      const docid = Number(node.docid);
      if (!Number.isFinite(docid) || visited.has(docid)) continue;
      visited.add(docid);

      const title = node.title || String(docid);
      const path = parentPath ? `${parentPath}/${title}` : title;
      const isDir = node.has_children === true;

      out.push({
        externalId: String(docid),
        title,
        path,
        parentId: parentId === null ? null : String(parentId),
        isDir,
      });

      if (isDir) {
        // 逐层拉取子级（API 只返回直接子级）
        let children: IWikiTreeNode[];
        try {
          children = await getSpacePageTree(ctx, docid);
        } catch {
          // 单个子树失败不应中断整体导入
          continue;
        }
        if (children.length > 0) {
          queue.push({ nodes: children, parentId: docid, parentPath: path, depth: depth + 1 });
        }
      }
    }
  }
  return out;
}
