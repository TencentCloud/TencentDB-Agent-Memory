/**
 * Knowledge Tools Injector — injects a `<knowledge_tools>` block listing
 * team knowledge resources (wiki / code-graph) with a two-step self-discovery
 * flow (tools/list → tools/call).
 *
 * v7 progressive exposure: prompt only contains resource list + discovery
 * entry points. Agent calls tools/list to discover available tools, then
 * tools/call to execute. Tool definitions live in the knowledge service,
 * not in the proxy.
 *
 * Strategy:
 *   - cacheStrategy: "session_init" — knowledge list fetched once at prewarm,
 *     reused for all turns in the session.
 *   - **Per-agent** (设计 §0.6): 读 meta agent-fixed-asset 绑定（过滤
 *     llm_wiki/code_graph）→ asset_ids(=knowledge_id) → 按 id 联查 entity_knowledge
 *     取渲染字段。绑定权威在 meta；明细缺失（未 ready）则不注入。
 *   - Fallback: 无 caller user-key / 无 agent → 退回 team 全量 list（过渡兼容）。
 *   - Failure / empty → 0 blocks (graceful degradation).
 *
 * See `docs/design/knowledge-injection-v7.md`。
 */

import type {
  AgentContext,
  AnchorTarget,
  AssetCapabilityFlags,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import {
  CoreKnowledgeClient,
  getCoreKnowledgeClient,
  type KnowledgeItem,
} from "../../knowledge/core-client.js";
import type { CoreSkillConfig } from "../../types.js";

const TAG = "[knowledge-tools-injector]";

export interface KnowledgeToolsInjectorConfig {
  /** Core kernel config (same endpoint as skill — 8420). */
  coreSkill: CoreSkillConfig;
}

export interface KnowledgeTelemetryContext {
  sessionKey?: string;
  userId?: string;
  teamId?: string;
  agentId?: string;
  agentSource?: string;
  spaceId?: string;
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function renderHeader(name: string, value: string): string {
  return "  -H " + shellQuote(`${name}: ${value}`) + " \\";
}

function toCompositeSessionKey(sessionKey?: string, agentSource?: string): string | undefined {
  if (!sessionKey) return undefined;
  if (!agentSource) return sessionKey;
  const prefix = `${agentSource}:`;
  return sessionKey.startsWith(prefix) ? sessionKey : `${prefix}${sessionKey}`;
}

/**
 * Render the `<knowledge_tools>` block from a list of knowledge resources.
 * Pure function for ease of testing.
 *
 * `service_url` is the tools self-discovery base (already includes the API
 * prefix, e.g. `http://host:8421/v3`). The tools endpoints are service-level
 * (`{service_url}/tools/list` | `/tools/call`); the target resource is selected
 * via the `knowledge_id` field in the body, NOT via the URL path.
 *
 * `serviceId` is the tenant identity (= `x-tdai-service-id`, unified with the
 * kernel routing key). The knowledge service REQUIRES it as a header on every
 * tools call, so we bake it into the curl examples the agent runs. Optional
 * telemetry context headers let the service attribute calls without embedding
 * secrets; all header values are shell-quoted before rendering.
 */
function filterResourcesByCapabilities(
  resources: KnowledgeItem[],
  caps: AssetCapabilityFlags | undefined,
): KnowledgeItem[] {
  if (!caps) return resources;
  return resources.filter((r) => {
    if (r.type === "wiki") return caps.llm_wiki !== false;
    if (r.type === "code-graph") return caps.code_graph !== false;
    return true;
  });
}

/**
 * Escape a value for use inside a double-quoted XML attribute. Resource names
 * and repo slugs are operator-supplied, so a stray `"` would otherwise break
 * the `<knowledge .../>` tag structure the agent parses.
 */
function xmlAttrEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Render `\n  name="escaped"`, or "" when the value is absent/blank. */
function attr(name: string, value: string | undefined | null): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return `\n  ${name}="${xmlAttrEscape(trimmed)}"`;
}

/**
 * Derive a repo slug (`<org>/.../<repo>`) from a clone URL, used as the anchor
 * hint the agent matches against the local workspace's git remote.
 *
 * Handles both `https://host/a/b/c.git` and `git@host:a/b/c.git`. Returns
 * undefined when the URL is absent or yields no usable path (e.g. wiki
 * resources, which have no repo).
 */
function deriveRepoSlug(repoUrl: string | undefined): string | undefined {
  if (!repoUrl) return undefined;
  const withoutScheme = repoUrl.replace(/^[a-z0-9+.-]+:\/\//i, "");
  // scp-like syntax (`git@host:org/repo.git`) — split on the first colon.
  const afterHost = withoutScheme.includes(":")
    ? withoutScheme.slice(withoutScheme.indexOf(":") + 1)
    : withoutScheme.slice(withoutScheme.indexOf("/") + 1);
  const slug = afterHost.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  return slug.length > 0 ? slug : undefined;
}

export function renderKnowledgeToolsBlock(
  resources: KnowledgeItem[],
  serviceId: string,
  telemetryContext: KnowledgeTelemetryContext = {},
): string | null {
  if (!resources || resources.length === 0) return null;

  const telemetryHeaders: Array<[string, string | undefined]> = [
    ["x-conversation-id", telemetryContext.sessionKey],
    ["x-tdai-user-id", telemetryContext.userId],
    ["x-tdai-team-id", telemetryContext.teamId],
    ["x-tdai-agent-id", telemetryContext.agentId],
    ["x-tdai-agent-source", telemetryContext.agentSource],
    ["x-tdai-space-id", telemetryContext.spaceId],
  ];
  const requestHeaderLines = [
    renderHeader("x-tdai-service-id", serviceId),
    ...telemetryHeaders
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([name, value]) => renderHeader(name, value)),
  ];

  const resourceTags = resources
    .map((r) => {
      // `match` 是 code-graph 的锚点判定依据：agent 拿它比对当前工作区的 git
      // remote，命中才调用。优先用后端下发的 repo_slug；缺失时从 repo_url 降级
      // 提取 `<org>/.../<repo>`。wiki 无 repo，不渲染该属性。
      const matchAttr = attr("match", r.repo_slug ?? deriveRepoSlug(r.repo_url));
      const branchAttr = attr("branch", r.repo_url ? (r.branch ?? "main") : undefined);
      // wiki 的 summary 是 LLM 依据页面标题生成的内容概述，是 agent 判断"该不该
      // 查这个 wiki"的唯一线索，必须保留。code-graph 的 summary 只是
      // "N 个文件、M 个符号节点"一类计数，对调用决策无帮助，不注入。
      const summaryAttr = r.type === "wiki" ? attr("about", r.summary) : "";
      return `<knowledge type="${r.type}" id="${r.knowledge_id}"\n  url="${r.service_url}"\n  name="${xmlAttrEscape(r.name)}"${matchAttr}${branchAttr}${summaryAttr} />`;
    })
    .join("\n\n");

  return [
    "<knowledge_tools>",
    "**团队知识库资源**：code-graph 是仓库的预建代码索引（符号 / 调用图 / 结构），wiki 是工程设计文档。两类各有判据，见下。",
    "",
    "## code-graph：何时调",
    "**前置条件**：资源的 match 与当前工作区对得上（比对 git remote / 仓库名）。对不上 → 该索引不是本仓的，用本地检索，不要试探性调用。",
    "",
    "命中后，**凡是需要跨文件的结构 / 关系 / 广度信息就用它**，典型场景：",
    "- 熟悉项目、理解模块架构、找入口（冷启动）",
    "- 定位符号、文件、某个概念在哪实现",
    "- 追调用链、依赖关系、数据流",
    "- 评估改动影响面、重构范围、能否安全删除（**即使已在改代码，这类问题仍该用它**）",
    "- 排查线上问题时找可疑代码路径、review 时找关联实现",
    "- 想不起某个能力叫什么名字、不确定是否已有实现（避免重复造）",
    "",
    "**不该用的只有一种情况**：你需要某段代码**此刻的精确内容**——要按行号/字符编辑、代码是你刚改过的、在 review 未提交的改动。索引是分支快照，会落后于工作区，这时以工作区源码为准。",
    "先用它建立全局认知、再落到具体文件做精确确认，是常态组合，不冲突。",
    "",
    "## wiki：何时调",
    "wiki 是设计文档，**与工作区无对应关系，不需要锚点匹配**（没有 match 属性是正常的，不代表对不上）。按 about 属性判断内容是否相关即可。",
    "问「为什么这么设计 / 背景与权衡 / 某概念在团队里的定义 / 历史决策与踩过的坑 / 这个模块的设计意图」时用它——这些答案在代码里找不到。",
    "代码怎么写的 → 用 code-graph；某段代码此刻的内容 → 读源码。",
    "",
    "## 意图 → 起手",
    "架构 / 熟悉项目 → explore（一次返回沿途源码）；X 在哪 → search；只要单个符号的定义 → node；谁调用 X / X 调了谁 → callers / callees；改 X 的影响面 → search 后 impact；为什么这么设计 → wiki search 后 read_page。",
    "组合：重构评估 = search → callers → impact。",
    "explore / node 返回的源码是逐字的，**不必对同一处再 Read 一遍**（除了上面那种要确认最新内容的情况）。",
    "",
    "## 已绑定资源",
    resourceTags,
    "",
    "## 调用方式（服务级统一端点，URL 直接用资源的 url 拼接）",
    "目标资源由 body 里的 knowledge_id 指定；**不要**把 knowledge_id 拼进 URL 路径。",
    `**每次请求都必须带请求头** \`x-tdai-service-id: ${serviceId}\`（租户标识，缺失会被拒绝）。`,
    "",
    "### Step 1: 拿工具清单（每个资源**首次**使用时调一次即可）",
    "curl -sSk -X POST <url>/tools/list \\",
    "  -H 'content-type: application/json' \\",
    ...requestHeaderLines,
    "  -d '{\"knowledge_id\":\"<知识id>\"}'",
    "",
    "返回: {code, message, data:{knowledge_id, type, name, summary, status, tools:[{name, description, params}, ...]}}",
    "记住返回的 tool name / params，**本会话内复用**，不要对同一资源反复调 list（忘了再调）。",
    "",
    "### Step 2: 执行工具",
    "curl -sSk -X POST <url>/tools/call \\",
    "  -H 'content-type: application/json' \\",
    ...requestHeaderLines,
    "  -d '{\"knowledge_id\":\"<知识id>\", \"tool_name\":\"<Step1返回的name>\", \"params\":{...}}'",
    "",
    "返回: {code, message, data}；code=0 成功。",
    "",
    "## 约定",
    "- tool_name 与 tools/list 返回的 name **完全一致**，不加前缀。params 必须是 JSON 对象，无参也传 {}。",
    "- 找文件用 explore / search（query 直接支持文件名，如 \"session-manager.ts\"）；files 只用于一次性总览目录结构，每个资源每会话最多一次。",
    "- wiki 先 search 命中再 read_page，不要全量 list_pages。",
    "- 多个资源可并行发起，无需串行等待。同一调用连续失败 2 次即放弃，回退本地检索。",
    "- 响应格式统一为 {code, message, data}，code=0 表示成功。",
    "</knowledge_tools>\n",
  ].join("\n");
}

/**
 * Knowledge tools injector.
 *
 * Anchor: lands in the `knowledge` semantic slot, co-located just AFTER the
 * memory region on each profile — CodeBuddy's <memories> tag / Claude Code's
 * # Memory section. Knowledge tools (wiki + code-graph) are a "cloud reference"
 * pairing naturally with memory, not with executable skills, so we deliberately
 * avoid sharing the `skills` slot.
 * Priority: HOOK_PRIORITY.WIKI (300).
 */
export class KnowledgeToolsInjector implements InjectionHook {
  id = "knowledge-tools-injector";
  point = "system.before_tools" as const;
  anchor: AnchorTarget = { slot: "knowledge", relation: "after" };
  priority: HookPriority = HOOK_PRIORITY.WIKI;
  description = "Inject the <knowledge_tools> block with team knowledge resources.";
  cacheStrategy: CacheStrategy = "session_init";

  constructor(
    private config: KnowledgeToolsInjectorConfig,
    /** Optional override (tests). */
    private clientOverride?: CoreKnowledgeClient,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const ids = this.resolveSession(ctx);
    if (!ids.teamId) return [];
    return this.fetchBlocks(
      ids.teamId,
      ids.agentId,
      ids.userKey,
      ids.spaceId,
      ids.assetCapabilities,
      "execute",
      {
        sessionKey: toCompositeSessionKey(ctx.metadata.sessionKey, ctx.metadata.agentSource),
        userId: ids.userId ?? undefined,
        teamId: ids.teamId,
        agentId: ids.agentId ?? undefined,
        agentSource: ctx.metadata.agentSource,
        spaceId: ids.spaceId ?? undefined,
      },
    );
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    const teamId = input.sessionInfo.team_id;
    if (!teamId) return [];
    return this.fetchBlocks(
      teamId,
      input.sessionInfo.agent_id ?? null,
      input.callerUserKey ?? null,
      input.sessionInfo.space_id ?? null,
      input.assetCapabilities,
      "prewarm",
      {
        sessionKey: toCompositeSessionKey(input.keyId, input.agentSource),
        userId: input.sessionInfo.user_id || input.userId,
        teamId,
        agentId: input.sessionInfo.agent_id,
        agentSource: input.agentSource,
        spaceId: input.sessionInfo.space_id,
      },
    );
  }

  private resolveSession(ctx: AgentContext): {
    teamId: string | null;
    agentId: string | null;
    userId: string | null;
    userKey: string | null;
    spaceId: string | null;
    assetCapabilities?: AssetCapabilityFlags;
  } {
    const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
    const session = custom?.session as Record<string, unknown> | undefined;
    const teamId = typeof session?.team_id === "string" && session.team_id.length > 0 ? session.team_id : null;
    const agentId = typeof session?.agent_id === "string" && session.agent_id.length > 0 ? session.agent_id : null;
    const userId = typeof session?.user_id === "string" && session.user_id.length > 0 ? session.user_id : null;
    const userKey = typeof custom?.userKey === "string" && custom.userKey.length > 0 ? custom.userKey : null;
    const spaceId = typeof session?.space_id === "string" && session.space_id.length > 0 ? session.space_id : null;
    const assetCapabilities = custom?.assetCapabilities as AssetCapabilityFlags | undefined;
    return { teamId, agentId, userId, userKey, spaceId, assetCapabilities };
  }

  private async fetchBlocks(
    teamId: string,
    agentId: string | null,
    userKey: string | null,
    spaceId: string | null,
    assetCapabilities: AssetCapabilityFlags | undefined,
    phase: "prewarm" | "execute",
    telemetryContext: KnowledgeTelemetryContext,
  ): Promise<ContextBlock[]> {
    try {
      const client = this.clientOverride ?? getCoreKnowledgeClient(this.config.coreSkill);

      console.log(`${TAG} ${phase} team=${teamId} agent=${agentId ?? "(none)"} userKey=${userKey ? "(set)" : "(none)"} space=${spaceId ?? "(none)"}`);

      // Per-agent（首选）：meta 绑定 → asset_ids → 按 id 联查明细。
      // serviceId 透传 spaceId（与 SkillInjector 一致：`/{agent}/{spaceId}/...`）。
      let resources: KnowledgeItem[];
      let scope: string;
      if (agentId && userKey) {
        const ids = await client.listAgentKnowledgeIds(agentId, userKey, { serviceId: spaceId ?? undefined });
        console.log(`${TAG} ${phase} per-agent path: listAgentKnowledgeIds → ${ids.length} ids [${ids.join(",")}]`);
        resources = ids.length > 0 ? await client.listKnowledgeByIds(teamId, ids, { serviceId: spaceId ?? undefined }) : [];
        console.log(`${TAG} ${phase} per-agent path: listKnowledgeByIds → ${resources.length} resources`);
        scope = `agent:${agentId}`;
      } else {
        // Fallback：无 caller 身份 → team 全量。
        // 传 space_id 作 kernel 租户路由 header（与 SkillInjector 一致）。
        resources = await client.listKnowledge(teamId, { serviceId: spaceId ?? undefined });
        console.log(`${TAG} ${phase} fallback path: listKnowledge → ${resources.length} resources`);
        scope = `team:${teamId}`;
      }

      resources = filterResourcesByCapabilities(resources, assetCapabilities);
      // 注入 prompt 里给 LLM 用的 service-id 也要是 spaceId（LLM 拿它调 KS 的 tools/list|call）。
      const injectionServiceId = spaceId || this.config.coreSkill.serviceId;
      const content = renderKnowledgeToolsBlock(resources, injectionServiceId, telemetryContext);
      if (!content) return [];
      return [{
        type: "text",
        content,
        metadata: {
          source: this.id,
          cacheKey: `knowledge-tools-injector:${scope}`,
        },
      }];
    } catch (err) {
      console.warn(`${TAG} ${phase} failed: ${(err as Error).message}`);
      return [];
    }
  }
}
