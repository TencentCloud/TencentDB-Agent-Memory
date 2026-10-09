/**
 * wiki-source —— wiki 外部来源的抽象。
 *
 * 与 code-source 对称：
 *   - **Provider（wiki 平台）** → `providers/<id>.ts`：平台常量 + 拉取实现
 *   - 认证方式复用 `code-source/auth-methods/` 的 AuthMethod（表单元数据 + 注入约定）
 *
 * 差异（相对 codegraph）：
 *   - wiki 需要 **列文档树 + 逐页拉内容**，无法靠一个 URL 完成
 *   - 因此 provider 必须实现 resolveRoot / listPages / fetchPage
 *   - 文档 §2.1 定义的契约；KS 侧实现，Panel 只调接口
 */

import type { AuthMethod } from "../code-source/auth-methods/types.js";

/** 前端下拉展示用的来源元数据。 */
export interface WikiSourceMeta {
  id: string;
  auth_method: AuthMethod["kind"];
  form_fields: ReadonlyArray<{ name: string; secret: boolean; required: boolean }>;
  token_doc_url?: string;
}

/**
 * 令牌申请页定位。
 *
 * **地址一律由部署配置提供**，不在代码里硬编码内网域名。两种形态：
 *
 * - `{ tokenUrlEnv }`（**优先**）：该 env 里就是**完整 URL**，原样使用、不拼接。
 *   适用于令牌页与来源不同域、或**与其它来源共用同一个令牌页**的场景
 *   （如 iWiki 与 TAPD 都用太湖 PAT 页 → 都指向同一个 `TAI_PAT_URL`）。
 * - `{ path }`：站内相对路径，拼到 `WIKI_SOURCE_<ID>_SITE_BASE_URL`。
 *
 * 用完整 URL 形态时，多个来源可以指向**同一个 env**，改地址只改一处，不会漏。
 */
export type TokenDoc =
  | { tokenUrlEnv: string }
  | { path: string };

/**
 * 遍历策略：决定"从导入根出发，如何发现文档"。
 *
 * - `"tree"`：走平台提供的**层级接口**（父 → 子），按目录结构展开。
 *     优点：结构完整、与平台目录一致；
 *     缺点：依赖平台有层级 API，且多为逐层接口（大空间递归次数多、耗时长）。
 *
 * - `"links"`：解析**页面正文里的超链接**来发现文档（类似爬虫）。
 *     优点：不依赖层级 API，任何能拿到正文的平台都可用；
 *     缺点：只能发现被链接到的页面，且需要拉正文（有额外请求开销）。
 */
export type CrawlMode = "tree" | "links";

/** links 策略的默认遍历深度（只从入口页的直接链接走一层）。 */
export const DEFAULT_LINKS_MAX_DEPTH = 1;

/** 遍历选项。 */
export interface CrawlOptions {
  mode?: CrawlMode;
  /** 最大遍历深度，1 = 只取入口页直接链接到的文档。仅 links 策略有意义。 */
  maxDepth?: number;
}

/** 导入根：目录 or 单文档。 */
export interface ResolvedRoot {
  rootType: "dir" | "doc";
  rootId: string;
  displayName: string;
  estimatedCount?: number;
  /**
   * 当目录根本身也是一个文档 id 时（部分平台的目录页与普通文档共用
   * 同一 URL 形态，如 `/p/<id>`），记下该 id，
   * 供 listPages 从它开始逐层展开。
   * 空间根（rootId 是空间键）不带此字段。
   */
  rootDocId?: string;
}

/** 远端节点引用（扁平，含目录节点）。 */
export interface RemotePageRef {
  externalId: string;
  title: string;
  path: string;
  parentId?: string | null;
  /** true = 目录，仅展示不可下载。 */
  isDir?: boolean;
  version?: string;
  updatedAt?: string;
}

/**
 * 拉取到的单篇内容。
 *
 * `title` 可为 undefined：部分 provider 的内容接口只回正文、不回标题
 * （实测确认存在此类平台）。此时由上层用列表阶段（listPages）的标题补全；
 * provider **不可用 id 兜底**，否则落盘文件名会退化成 `<id>.md`。
 */
export interface RemotePageContent extends Omit<RemotePageRef, "title" | "path"> {
  title?: string;
  path?: string;
  markdown: string;
  fidelity: "lossless" | "lossy";
  warnings?: string[];
}

/**
 * 拉取执行上下文。
 *
 * 凭据**由此注入**，provider 不自行读库；
 * 这样 provider 保持纯函数式，便于测试与复用（含定时同步）。
 */
export interface SourceContext {
  /** 明文凭据（PAT 等）。 */
  secret: string;
  /** basic 认证时的用户名（可选）。 */
  username?: string;
  /** MCP / API 端点。 */
  endpoint: string;
  /** 单次请求超时（ms）。 */
  timeoutMs?: number;
}

/**
 * wiki 来源 provider 契约（文档 §2.1）。
 *
 * 一个平台文件 = 一个实现：
 *   - `id` / `authMethod` / `sitePaths`：平台常量
 *   - `resolveRoot` / `listPages` / `fetchPage`：平台拉取能力
 *   - `fetchPages`：可选批量，不实现则降级逐个 fetchPage
 */
export interface WikiSourceProvider {
  readonly id: string;
  readonly authMethod: AuthMethod;
  readonly sitePaths: {
    /** 令牌申请页定位（站内路径 / 跨站路径，见 TokenDoc）。 */
    tokenDoc?: TokenDoc;
  };

  /**
   * 服务端点地址的**配置名后缀**，拼成 `WIKI_SOURCE_<UPPER_ID>_<suffix>`。
   *
   * 默认 `"MCP_URL"`（走 MCP 协议型）；
   * REST 型平台可声明为 `"API_BASE_URL"` 等，避免被迫叫 MCP。
   *
   * 地址一律来自部署配置，**无内置默认值**（内网基础设施必须显式配置）。
   */
  readonly endpointEnvSuffix?: string;

  /** 解析地址为导入根，自动判定目录 or 文档。 */
  resolveRoot(ctx: SourceContext, inputUrl: string): Promise<ResolvedRoot>;

  /**
   * 列举节点，扁平返回且保留目录节点。
   *
   * `opts` 可选：调用方可指定遍历策略（见 CrawlOptions）。
   * 不传 → 用 provider 默认策略（`defaultCrawlMode`，未声明时按 `"tree"`）。
   */
  listPages(
    ctx: SourceContext,
    root: ResolvedRoot,
    opts?: CrawlOptions,
  ): Promise<RemotePageRef[]>;

  /**
   * 该 provider 的默认遍历策略。**可选**，未声明时按 `"tree"`。
   *
   * 取舍：
   * - `tree` 与平台目录结构一致、覆盖完整，是"导入整个空间/目录"的自然默认；
   *   但依赖平台有层级接口，且多为逐层 API（大空间递归耗时较长）。
   * - `links` 只须读正文、请求更少，适合"从入口页抓一批相关文档"；
   *   但只能发现被链接到的页面。
   *
   * 调用方始终可用 `CrawlOptions.mode` 覆盖。
   */
  readonly defaultCrawlMode?: CrawlMode;

  fetchPage(ctx: SourceContext, pageId: string): Promise<RemotePageContent>;

  /** 可选批量；不支持则降级逐个 fetchPage。 */
  fetchPages?(ctx: SourceContext, ids: string[]): Promise<RemotePageContent[]>;
}
