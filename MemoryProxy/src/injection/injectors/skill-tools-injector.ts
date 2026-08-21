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

  const readTools = [
    `  <tool name="skill_search">`,
    `    path: ${bridge}/search`,
    `    body: {"query": "描述你要找什么 skill 的关键词（必填，>=1字符）"}`,
    `    use:  在**你在团队中有权限访问**的 skill 中按关键词 + 语义检索匹配项（跨 agent，但**不含**其他人设置为私密的 skill —— 与前端「团队资产」tab 展示一致）。query 必须是非空字符串，建议写 2-5 个相关关键词。当你觉得自己自带的 skill 不够用时，用它发现团队里其他可用的 skill。返回条数由服务端固定，若结果不理想请换一组关键词重试，不要在 body 里加 top_k/mode 等其它字段（会被忽略）。`,
    `  </tool>`,
    "",
    // 暂时下线：<available_skills> 块已经注入 agent 自带的 skill 列表，功能重叠。
    // 后续如果需要分页刷新（skill 太多截断时）再恢复。
    // `  <tool name="skill_list">`,
    // `    path: ${bridge}/list`,
    // `    body: {"filters": {"owner_agent_id": "?可选", "name_prefix": "?可选"}, "pagination": {"limit": 50}}`,
    // `    use:  列出 head + active skill；按 owner / 前缀过滤`,
    // `  </tool>`,
    // "",
    `  <tool name="skill_view">`,
    `    path: ${bridge}/get-by-name`,
    `    body: {"skill_name": "<skill 名字>", "include_content": true, "include_manifest": true}`,
    `    use:  **打开一个 skill 的入口**：拿到 SKILL.md 全文 + 资源目录树（manifest）。想读某个资源文件的字节，必须先调这个工具从 manifest 里挑出 path，再用 skill_files_read。skill_name 用 <available_skills> 里 \`- name: description\` 那个 name，或 skill_search 结果里的 name 字段。`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_read">`,
    `    path: ${bridge}/files/read`,
    `    body: {"skill_id": "skl-xxx", "path": "scripts/run.sh", "encoding": "utf-8|base64"}`,
    `    use:  读取单个资源文件内容。**必须先调 skill_view 拿 manifest**，从里面挑出 skill_id + path，本工具才能定位。默认返回 JSON 信封（含 base64/utf-8 编码的字节）。\n    若需下载到本地：在 curl 末尾加 -o <本地路径>，proxy 会返回原始字节直接写入文件，不进上下文。下载的脚本需 chmod +x 后再执行。`,
    `  </tool>`,
    "",
    `  <tool name="skill_extract">`,
    `    path: ${bridge}/extract`,
    `    body: {"reason": "?可选，简要说明为什么觉得当前对话值得提取为 skill（写清楚有助于后台抽取器识别边界）"}`,
    `    use:  立即归档当前对话触发一次 skill 抽取（异步任务，由后台 agent 分析对话内容生成 skill）。proxy 从 session 拿身份 + 用 core 侧累积的对话缓冲，你不用传 messages。适合在"用户已经跑通一段完整流程、值得复用"时主动触发。`,
    `  </tool>`,
  ];

  const writeTools = [
    `  <tool name="skill_create">`,
    `    path: ${bridge}/create`,
    `    body: {"name": "string", "content": "SKILL.md 全文（含 frontmatter）", "resources": "?可选数组"}`,
    `    use:  新建 skill；owner 自动 = 当前 agent`,
    `  </tool>`,
    "",
    `  <tool name="skill_update">`,
    `    path: ${bridge}/update`,
    `    body: {"skill_id": "skl-xxx", "content": "新 SKILL.md"}`,
    `    use:  替换 SKILL.md（version+1）`,
    `  </tool>`,
    "",
    `  <tool name="skill_patch">`,
    `    path: ${bridge}/patch`,
    `    body: {"skill_id": "skl-xxx", "old_string": "...", "new_string": "...", "replace_all": false}`,
    `    use:  SKILL.md 子串替换（避免大 diff）`,
    `  </tool>`,
    "",
    `  <tool name="skill_delete">`,
    `    path: ${bridge}/delete`,
    `    body: {"skill_id": "skl-xxx"}`,
    `    use:  软删（archived；不递增版本）`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_write">`,
    `    path: ${bridge}/files/write`,
    `    body: {"skill_id": "skl-xxx", "files": [{"path": "scripts/x.sh", "content": "...", "encoding": "utf-8", "is_executable": true}]}`,
    `    use:  增/改资源文件（version+1）`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_remove">`,
    `    path: ${bridge}/files/remove`,
    `    body: {"skill_id": "skl-xxx", "paths": ["scripts/old.sh"]}`,
    `    use:  删资源文件（version+1）`,
    `  </tool>`,
  ];

  const note = allowLlmWrite
    ? "错误处理：响应是 `{code, message, request_id, data?}` 信封；`code != 0` 表示业务错。常见："
    : "注意：当前仅开放只读操作。如需创建/修改 skill 请联系管理员。\n错误处理：响应是 `{code, message, request_id, data?}` 信封；`code != 0` 表示业务错。常见：";

  const readErrors = [
    "- 40001 参数校验失败：body 字段缺失/格式错，看 message 里具体字段名。",
    "- 40101 session not initialized：session 未识别（很可能你在错误的 conversation 环境用了这个工具）。",
    "- 40401 SKILL_NOT_FOUND：skill 不存在或不属于你所在的 agent；先用 skill_search 找同类 skill。",
    "- 50301 upstream unavailable：core 侧临时不可达，稍后重试。",
  ];
  const writeErrors = [
    "- 40301 SKILL_NOT_OWNER：你不是 owner，无法修改。",
    "- 40901 SKILL_VERSION_STALE：版本过期，先 skill_view 拿最新版本再写。",
    "- 42201 SKILL_NAME_DUPLICATE：同 team 重名。",
    "- 42202 SKILL_PATCH_NOT_UNIQUE：old_string 不唯一，传 replace_all=true。",
  ];

  return [
    "<skill_tools>",
    "以下是云端 skill 操作工具。**这些不是本地工具**，需要用 Bash 调用 curl 命中 proxy 的 skill-bridge 路径来执行。",
    "proxy 会自动注入身份与鉴权（user_id / team_id / agent_id 由 session 决定），body 里你只需要传业务字段。",
    "",
    "调用模板：",
    `  curl -sSk -X POST <bridge>/<action> -H 'content-type: application/json'${authHeader} -d '{...业务字段...}'`,
    `  其中 <bridge> = ${bridge}`,
    "",
    "可用工具：",
    "",
    ...readTools,
    ...(allowLlmWrite ? [""] : []),
    ...(allowLlmWrite ? writeTools : []),
    "",
    note,
    ...readErrors,
    ...(allowLlmWrite ? writeErrors : []),
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
        // Stable cache-dedup key — varies by allowLlmWrite to avoid stale cache
        cacheKey: `skill-tools-injector:catalog:${allowLlmWrite ? "rw" : "ro"}`,
      },
    }];
  }
}
