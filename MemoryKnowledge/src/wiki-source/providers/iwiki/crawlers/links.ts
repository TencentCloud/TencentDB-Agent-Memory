/**
 * 遍历策略之一：解析**页面正文里的超链接**来发现文档（类似爬虫）。
 *
 * 适用：不依赖平台层级 API —— 任何能拿到正文的平台都可用。
 * 特点：
 *   - 只能发现"被入口页链接到"的页面（不保证覆盖整个空间）
 *   - 需要拉正文来解析链接（有额外请求开销）
 *   - 默认只走一层（入口页的直接链接），避免请求量爆炸
 */

import type { RemotePageRef, SourceContext } from "../../../types.js";
import { getDocument, getMetadata } from "../mcp-client.js";

/**
 * 从正文中抽取文档 id（去重、保序）。
 *
 * 正则在**函数内创建**：带 `g` 标志的正则对象会持有 lastIndex 状态，
 * 模块级共享会在多次调用/多个正则交替匹配时互相污染（曾导致抽出 "2)" 这类脏 id）。
 */
export function extractDocIds(markdown: string): string[] {
  // markdown 链接语法：`[标题](https://.../p/123)` —— id 不含 `/?#)` 与空白
  const mdLinkRe = /\((?:https?:\/\/[^)\s]*?)?\/(?:p|pages?)\/([^/?#)\s]+)\)/gi;
  // 裸 URL：任意位置的 `.../p/123`
  const bareUrlRe = /\/(?:p|pages?)\/([^/?#)\s]+)/gi;

  const out: string[] = [];
  const seen = new Set<string>();

  const collect = (re: RegExp) => {
    for (let m = re.exec(markdown); m; m = re.exec(markdown)) {
      const id = m[1];
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  };

  collect(mdLinkRe);
  collect(bareUrlRe);
  return out;
}

/**
 * 从入口页出发，按正文超链接逐层发现文档。
 *
 * @param rootIds   入口页 id 列表
 * @param maxDepth  最大层数；1 = 只取入口页直接链接到的文档（默认）
 */
export async function crawlLinks(
  ctx: SourceContext,
  rootIds: string[],
  maxDepth: number,
): Promise<RemotePageRef[]> {
  const out: RemotePageRef[] = [];
  const visited = new Set<string>(rootIds);

  // 先取入口页自身
  let frontier: Array<{ id: string; parentId: string | null; depth: number }> = rootIds.map(
    (id) => ({ id, parentId: null, depth: 0 }),
  );

  while (frontier.length > 0) {
    const next: typeof frontier = [];

    for (const item of frontier) {
      // 标题优先从 metadata 取（getDocument 只回正文、不带 title）
      let title = item.id;
      let markdown = "";
      try {
        const [meta, doc] = await Promise.all([
          getMetadata(ctx, item.id).catch(() => undefined),
          getDocument(ctx, item.id),
        ]);
        if (meta?.title) title = meta.title;
        markdown = doc.markdown ?? "";
      } catch {
        // 单页取不到不应中断整体遍历
        continue;
      }

      out.push({
        externalId: item.id,
        title,
        path: title,
        parentId: item.parentId,
        isDir: false,
      });

      // 深度到顶就不再展开
      if (item.depth >= maxDepth) continue;

      for (const childId of extractDocIds(markdown)) {
        if (visited.has(childId)) continue;
        visited.add(childId);
        next.push({ id: childId, parentId: item.id, depth: item.depth + 1 });
      }
    }

    frontier = next;
  }

  return out;
}
