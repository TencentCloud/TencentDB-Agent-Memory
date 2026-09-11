/**
 * Skill Tools Injector — injects a static `<skill_tools>` block describing
 * cloud-skill operations as curl recipes.
 *
 * Why static: the LLM does NOT see these as native tools (we don't push to
 * `body.tools` — the agent host wouldn't know how to handle them). Instead
 * the LLM uses its existing Bash tool to curl `<proxy_base>/skill-bridge/...`,
 * which the proxy's `/skill-bridge/*` reverse proxy then forwards to core
 * with auth + IdFields injected from the session.
 *
 * The block is rendered once per session (at session_init prewarm) — its
 * content depends only on the proxy base URL, which is stable for the
 * session.
 *
 * Tools injected:
 *   Always (read-only): skill_search, skill_view, skill_files_read,
 *                       skill_extract
 *   Only when allowLlmWrite=true: skill_create, skill_update, skill_patch,
 *                                skill_delete, skill_files_write, skill_files_remove
 *
 * Note: skill_list is intentionally omitted — the <available_skills> block
 * already provides the agent's owned skill catalogue at session init.
 *
 * Sister hook: `skill-injector.ts` produces the dynamic `<available_skills>`
 * block (agent-owned skill listing from /v3/skill/listing).
  *
 * See `docs/design/2026-06-17-team-skill-proxy-runtime.md` §4.
 */

import type {
  AgentContext,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";

export interface SkillToolsInjectorConfig {
  /**
   * Base URL the LLM should curl. Filled into every `<tool>` recipe.
   * E.g. `http://127.0.0.1:8096`. Trailing slash trimmed.
   */
  proxyBaseUrl: string;
  /**
   * 是否允许主模型创建/修改 skill。默认 false。
   * false 时只注入只读工具（search/list/view/files_read）。
   * 显式设为 true 后注入全部 10 个工具。
   */
  allowLlmWrite?: boolean;
}

/**
 * Render the entire `<skill_tools>` block as a single text string. Pure
 * function for ease of testing.
 */
export function renderSkillToolsBlock(
  proxyBaseUrl: string,
  allowLlmWrite = true,
  sessionId?: string,
  spaceId?: string,
): string {
  const base = proxyBaseUrl.replace(/\/$/, "");
  const bridge = `${base}/skill-bridge/v3/skill`;

  // gateway 需要 `x-tdai-service-id: <spaceId>` 才放行；`x-conversation-id`
  // 让 proxy 复用 session 里的身份 (user_id / team_id / agent_id)。
  const sessionHeader = sessionId ? ` -H 'x-conversation-id: ${sessionId}'` : "";
  const tenantHeader = spaceId ? ` -H 'x-tdai-service-id: ${spaceId}'` : "";
  const authHeader = `${tenantHeader}${sessionHeader}`;

  // ── skill_view 用 skill_id(get) 还是 skill_name(get-by-name) ──
  // 默认 id → skill_view 打 /get，body 传 skill_id（配合 available_skills 渲染带 id）。
  // SKILL_VIEW_MODE=name → 回退到 /get-by-name + skill_name（旧行为）。
  // 依据 skill_eval v9(name) vs v10(id) 对比实验：id 模式有调用时 correct% 更高、unknown 减半。
  const skillViewMode = (process.env.SKILL_VIEW_MODE ?? "id").toLowerCase() === "name" ? "name" : "id";
  const skillViewTool =
    skillViewMode === "id"
      ? [
          `  <curl_recipe id="skill_view">`,
          `    path: ${bridge}/get`,
          `    body: {"skill_id": "<skill 的 id, 形如 skl-xxx>", "include_content": true, "include_manifest": true}`,
          `    use: 工作流明确匹配且完整说明不在上下文时，读取 SKILL.md 后执行。skill_id 来自列表 id= 或 skill_search；词面相似不调用。`,
          `  </curl_recipe>`,
        ]
      : [
          `  <curl_recipe id="skill_view">`,
          `    path: ${bridge}/get-by-name`,
          `    body: {"skill_name": "<skill 名字>", "include_content": true, "include_manifest": true}`,
          `    use: 工作流明确匹配且完整说明不在上下文时，读取 SKILL.md 后执行。skill_name 来自列表或 skill_search；词面相似不调用。`,
          `  </curl_recipe>`,
        ];

  const readTools = [
    `  <curl_recipe id="skill_search">`,
    `    path: ${bridge}/search`,
    `    body: {"query": "非空的 2-5 个相关关键词"}`,
    `    use: 需要专项工作流且列表无明确匹配时搜索；列表已有明确匹配时不要搜索。query 写 2-5 个意图词，无其他字段。`,
    `  </curl_recipe>`,
    "",
    // 暂时下线：<available_skills> 块已经注入 agent 自带的 skill 列表，功能重叠。
    // 后续如果需要分页刷新（skill 太多截断时）再恢复。
    // `  <curl_recipe id="skill_list">`,
    // `    path: ${bridge}/list`,
    // `    body: {"filters": {"owner_agent_id": "?可选", "name_prefix": "?可选"}, "pagination": {"limit": 50}}`,
    // `    use:  列出 head + active skill；按 owner / 前缀过滤`,
    // `  </curl_recipe>`,
    // "",
    ...skillViewTool,
    "",
    `  <curl_recipe id="skill_files_read">`,
    `    path: ${bridge}/files/read`,
    `    body: {"skill_id": "skl-xxx", "path": "scripts/run.sh", "encoding": "utf-8|base64"}`,
    `    use: 不能跳过 skill_view；按 manifest 的 skill_id + path 读取单个资源；下载可加 -o <本地路径>。`,
    `  </curl_recipe>`,
    "",
    `  <curl_recipe id="skill_extract">`,
    `    path: ${bridge}/extract`,
    `    body: {"reason": "?为什么该流程可复用"}`,
    `    use: 完整流程已跑通且可复用时异步抽取；无需传 messages。`,
    `  </curl_recipe>`,
  ];

  const writeTools = [
    `  <curl_recipe id="skill_create">`,
    `    path: ${bridge}/create`,
    `    body: {"name": "string", "content": "SKILL.md 全文（含 frontmatter）", "resources": "?可选数组"}`,
    `    use:  新建 skill；owner 自动 = 当前 agent`,
    `  </curl_recipe>`,
    "",
    `  <curl_recipe id="skill_update">`,
    `    path: ${bridge}/update`,
    `    body: {"skill_id": "skl-xxx", "content": "新 SKILL.md"}`,
    `    use:  替换 SKILL.md（version+1）`,
    `  </curl_recipe>`,
    "",
    `  <curl_recipe id="skill_patch">`,
    `    path: ${bridge}/patch`,
    `    body: {"skill_id": "skl-xxx", "old_string": "...", "new_string": "...", "replace_all": false}`,
    `    use:  SKILL.md 子串替换（避免大 diff）`,
    `  </curl_recipe>`,
    "",
    `  <curl_recipe id="skill_delete">`,
    `    path: ${bridge}/delete`,
    `    body: {"skill_id": "skl-xxx"}`,
    `    use:  物理删除 skill 全部版本`,
    `  </curl_recipe>`,
    "",
    `  <curl_recipe id="skill_files_write">`,
    `    path: ${bridge}/files/write`,
    `    body: {"skill_id": "skl-xxx", "files": [{"path": "scripts/x.sh", "content": "...", "encoding": "utf-8", "is_executable": true}]}`,
    `    use:  增/改资源文件（version+1）`,
    `  </curl_recipe>`,
    "",
    `  <curl_recipe id="skill_files_remove">`,
    `    path: ${bridge}/files/remove`,
    `    body: {"skill_id": "skl-xxx", "paths": ["scripts/old.sh"]}`,
    `    use:  删资源文件（version+1）`,
    `  </curl_recipe>`,
  ];

  const note = `${allowLlmWrite ? "" : "仅开放只读操作；"}业务 code 非零按 message 处理；HTTP 4xx 不原样重试，5xx 最多重试一次。`;
  const writeErrors = "写操作 code：40301 非 owner；40901 版本过期；42201 重名；42202 patch 不唯一。";

  return [
    "<skill_tools>",
    "通过原生 Bash 的 command 执行完整 curl；下列 curl_recipe id 仅用于选择请求模板，不是原生函数名。proxy 补充身份与鉴权。",
    `调用模板：curl -sSk -X POST <path> -H 'content-type: application/json'${authHeader} -d '<body>'`,
    "",
    "curl 配方：",
    "",
    ...readTools,
    ...(allowLlmWrite ? [""] : []),
    ...(allowLlmWrite ? writeTools : []),
    "",
    note,
    ...(allowLlmWrite ? [writeErrors] : []),
    "</skill_tools>",
  ].join("\n");
}

/**
 * Skill tools injector.
 *
 * Anchor: lands BEFORE the `skills` slot (CodeBuddy: `<agent_skills>`),
 * priority just before SkillInjector so `<skill_tools>` reads naturally
 * before `<cloud_skills>`.
 */
export class SkillToolsInjector implements InjectionHook {
  id = "skill-tools-injector";
  point = "system.before_tools" as const;
  /** Place ahead of `<available_skills>` (which uses slot=skills, before). */
  anchor: AnchorTarget = { slot: "skills", relation: "before" };
  /** Slightly higher priority than SkillInjector so this block precedes it. */
  priority: HookPriority = HOOK_PRIORITY.SKILL - 1;
  description = "Inject the static <skill_tools> curl-recipe block.";
  /** Block content depends only on proxy base URL — fully session-static. */
  cacheStrategy: CacheStrategy = "session_init";

  constructor(private config: SkillToolsInjectorConfig) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as { skill?: boolean } | undefined;
    if (caps?.skill === false) return [];
    return this.renderBlocks(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.skill === false) return [];
    return this.renderBlocks(undefined, input.sessionInfo.session_id, input.sessionInfo.space_id);
  }

  private renderBlocks(ctx?: AgentContext, prewarmSessionId?: string, prewarmSpaceId?: string): ContextBlock[] {
    const allowLlmWrite = this.config.allowLlmWrite ?? false;

    let sessionId = prewarmSessionId;
    let spaceId = prewarmSpaceId;
    if (ctx) {
      const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
      const session = custom?.session as Record<string, unknown> | undefined;
      const sid = session?.session_id;
      if (typeof sid === "string" && sid.length > 0) {
        sessionId = sid;
      }
      const sp = session?.space_id;
      if (typeof sp === "string" && sp.length > 0) {
        spaceId = sp;
      }
    }

    const content = renderSkillToolsBlock(this.config.proxyBaseUrl, allowLlmWrite, sessionId, spaceId);
    return [{
      type: "text",
      content,
      metadata: {
        source: this.id,
        // Stable cache-dedup key — varies by allowLlmWrite + skillViewMode to avoid stale cache
        // (SKILL_VIEW_MODE=id/name 须区分缓存,否则两模式串同一份 session_init 块)
        cacheKey: `skill-tools-injector:catalog:${allowLlmWrite ? "rw" : "ro"}:${(process.env.SKILL_VIEW_MODE ?? "id").toLowerCase() === "name" ? "name" : "id"}`,
      },
    }];
  }
}
