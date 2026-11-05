/**
 * iWiki provider —— 外部 wiki 来源之一，走 MCP 协议。
 *
 * 认证：个人令牌（Bearer），由调用方注入；令牌申请页地址来自部署配置
 * （见 sitePaths.tokenDoc，用完整 URL 形态），**不在代码中写入具体域名**。
 *
 * 支持两种遍历策略（见 CrawlMode），默认 tree（见下方 defaultCrawlMode）：
 *   - tree：走层级接口逐层展开（结构完整，但大空间递归耗时较长）
 *   - links：解析正文超链接发现文档（不依赖层级 API，更通用、更便宜，
 *     但只能发现被链接到的页面）
 */

import { bearerAuthMethod } from "../../../code-source/auth-methods/bearer.js";
import type {
  CrawlOptions,
  RemotePageContent,
  RemotePageRef,
  ResolvedRoot,
  SourceContext,
  WikiSourceProvider,
} from "../../types.js";
import { DEFAULT_LINKS_MAX_DEPTH } from "../../types.js";
import { getDocument, getMetadata, getSpaceRoot } from "./mcp-client.js";
import { crawlTree } from "./crawlers/tree.js";
import { crawlLinks } from "./crawlers/links.js";

/** 单文档 URL 形如 <站点>/p/<id> 或 /pages/<id> */
const DOC_URL_RE = /(?:\/(?:p|pages?)\/)([^/?#]+)/i;
/** 空间 URL 形如 <站点>/spaces/<spaceKey> */
const SPACE_URL_RE = /\/spaces?\/([^/?#]+)/i;

export const iwikiProvider: WikiSourceProvider = {
  id: "iwiki",
  authMethod: bearerAuthMethod,
  sitePaths: {
    // 令牌由**另一个系统**颁发（太湖 PAT，与 iwiki 不同域），且该令牌页被多个来源共用
    // （TAPD 的太湖令牌方式也是它）—— 故指向**全局共用**的 TAI_PAT_URL：
    // 该 env 里是完整 URL，代码原样使用、不拼路径、不内置域名。
    tokenDoc: { tokenUrlEnv: "TAI_PAT_URL" },
  },

  /**
   * 默认用 tree：与平台目录结构一致、覆盖完整，符合"导入整个空间/目录"的默认预期。
   *
   * 代价：层级接口是逐层的，大空间递归耗时较长（实测 5748 节点约 3–4 分钟）。
   * 若只想"从入口页抓一批相关文档"，调用方可显式传 `{ mode: "links", maxDepth: 1 }`
   * 走超链接方式（更快、不依赖层级 API，但只覆盖被链接到的页面）。
   */
  defaultCrawlMode: "tree",

  async resolveRoot(ctx: SourceContext, inputUrl: string): Promise<ResolvedRoot> {
    const docMatch = DOC_URL_RE.exec(inputUrl);
    const spaceMatch = SPACE_URL_RE.exec(inputUrl);

    // /p/<docid>：可能是普通文档，也可能是**目录页**（iWiki 里目录同样有 /p/ 链接）。
    // 实测 metadata.content_type === "FOLDER" 即为目录。
    // 早期版本一律按单文档处理 → 目录页只返回自身、子文档全丢，表现为"没有显示子文档"。
    if (docMatch?.[1]) {
      const docId = docMatch[1];
      // 先取元数据拿到标题（getDocument 正文可能很大）
      let title = docId;
      let isFolder = false;
      try {
        const meta = await getMetadata(ctx, docId);
        if (meta.title) title = meta.title;
        isFolder = meta.contentType === "FOLDER";
      } catch {
        /* 元数据失败不阻断，按普通文档兜底 */
      }

      if (!isFolder) {
        return { rootType: "doc", rootId: docId, displayName: title, estimatedCount: 1 };
      }

      // 目录根：根自身作为顶级节点，其下逐层展开
      return {
        rootType: "dir",
        rootId: docId,
        displayName: title,
        estimatedCount: -1, // 需展开后才知道实际数量
        rootDocId: docId,
      };
    }

    // 空间：/spaces/<spaceKey>
    if (spaceMatch?.[1]) {
      const spaceKey = spaceMatch[1];
      const roots = await getSpaceRoot(ctx, spaceKey);
      return {
        rootType: "dir",
        rootId: spaceKey,
        displayName: spaceKey,
        estimatedCount: roots.length,
      };
    }

    throw new Error(
      // 不在提示里写死站点域名（内网地址）：只说明路径形态
      `无法从 URL 解析 iWiki 空间或文档（期望路径形如 /spaces/<spaceKey> 或 /p/<docid>）`,
    );
  },

  async listPages(
    ctx: SourceContext,
    root: ResolvedRoot,
    opts?: CrawlOptions,
  ): Promise<RemotePageRef[]> {
    const mode = opts?.mode ?? iwikiProvider.defaultCrawlMode ?? "tree";

    // 单文档根：无论哪种策略都只有它自己（links 模式会在下面继续展开其链接）
    if (root.rootType === "doc" && mode === "tree") {
      return [
        {
          externalId: root.rootId,
          title: root.displayName,
          path: root.displayName,
          parentId: null,
          isDir: false,
        },
      ];
    }

    if (mode === "links") {
      // 入口页：单文档根 = 它自己；目录根（含空间根）= 该根下的入口页
      // 空间根没有单一入口页，退化为取空间根级页面作为入口
      const entries =
        root.rootType === "doc"
          ? [root.rootId]
          : root.rootDocId
            ? [root.rootDocId]
            : (await getSpaceRoot(ctx, root.rootId)).map((n) => String(n.docid));

      const maxDepth = Math.max(1, opts?.maxDepth ?? DEFAULT_LINKS_MAX_DEPTH);
      return crawlLinks(ctx, entries, maxDepth);
    }

    // tree 策略：目录根本身是文档（/p/<docid> 且是 FOLDER）→ 把它作为顶级节点
    if (root.rootDocId) {
      const self = {
        docid: Number(root.rootDocId),
        title: root.displayName,
        has_children: true,
      };
      return crawlTree(ctx, [self]);
    }

    // 空间：先取根级，再逐层展开
    const roots = await getSpaceRoot(ctx, root.rootId);
    return crawlTree(ctx, roots);
  },

  async fetchPage(ctx: SourceContext, pageId: string): Promise<RemotePageContent> {
    const doc = await getDocument(ctx, pageId);
    // 注意：getDocument 只回正文、不带 title（实测确认）。
    // 这里**不能**用 pageId 兜底 title —— 否则上层会把它当真实标题，
    // 落盘文件名退化成 <docid>.md。留空交由上层用列表阶段的标题补全。
    return {
      externalId: pageId,
      title: doc.title,
      path: doc.title,
      isDir: false,
      markdown: doc.markdown,
      fidelity: doc.markdown ? "lossless" : "lossy",
    };
  },
};
