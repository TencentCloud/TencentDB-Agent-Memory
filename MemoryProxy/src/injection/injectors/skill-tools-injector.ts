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
import { renderPlatformHint } from "../shell-template.js";
import { resolveInjectionTuning } from "../tuning.js";
import type { InjectionTuningConfig } from "../../types.js";

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
  /** 注入微调（A/B）：skillTools=false 时不注入本块。 */
  tuning?: InjectionTuningConfig;
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
  tools?: Array<{ name?: unknown; function?: { name?: unknown } }>,
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
    `    use: 发现团队可用 skill（跨 agent，不含他人私密项）；自带 skill 不够时用它`,
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
    `    use: 打开 skill 拿 SKILL.md 全文 + 资源清单；读文件前必调`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_read">`,
    `    path: ${bridge}/files/read`,
    `    body: {"skill_id": "skl-xxx", "path": "scripts/run.sh", "encoding": "utf-8|base64"}`,
    `    use: 读取单个资源文件（先 skill_view 拿 skill_id + path）`,
    `  </tool>`,
    "",
    `  <tool name="skill_extract">`,
    `    path: ${bridge}/extract`,
    `    body: {"reason": "?可选说明"}`,
    `    use: 把已跑通的流程归档为 skill（异步；proxy 自动取对话缓冲）`,
    `  </tool>`,
  ];

  const writeTools = [
    `  <tool name="skill_create">`,
    `    path: ${bridge}/create`,
    `    body: {"name": "string", "content": "SKILL.md 全文（含 frontmatter）", "resources": "?可选数组"}`,
    `    use: 新建 skill（owner=当前 agent）`,
    `  </tool>`,
    "",
    `  <tool name="skill_update">`,
    `    path: ${bridge}/update`,
    `    body: {"skill_id": "skl-xxx", "content": "新 SKILL.md"}`,
    `    use: 整体替换 SKILL.md`,
    `  </tool>`,
    "",
    `  <tool name="skill_patch">`,
    `    path: ${bridge}/patch`,
    `    body: {"skill_id": "skl-xxx", "old_string": "...", "new_string": "...", "replace_all": false}`,
    `    use: 局部替换（小片段修改用）`,
    `  </tool>`,
    "",
    `  <tool name="skill_delete">`,
    `    path: ${bridge}/delete`,
    `    body: {"skill_id": "skl-xxx"}`,
    `    use: 软删`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_write">`,
    `    path: ${bridge}/files/write`,
    `    body: {"skill_id": "skl-xxx", "files": [{"path": "scripts/x.sh", "content": "...", "encoding": "utf-8", "is_executable": true}]}`,
    `    use: 增/改资源文件`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_remove">`,
    `    path: ${bridge}/files/remove`,
    `    body: {"skill_id": "skl-xxx", "paths": ["scripts/old.sh"]}`,
    `    use: 删资源文件`,
    `  </tool>`,
  ];

  const note = allowLlmWrite
    ? "错误处理：响应为 {code,message}，code!=0 即业务错（40001 参数错 / 40101 会话未初始化 / 40401 不存在 / 40301 非 owner / 40901 版本过期）。"
    : "当前仅开放只读；创建/修改请先联系管理员。错误处理：{code,message}，code!=0 即业务错。";

  return [
    "<skill_tools>",
    "云端 skill 工具：用 shell 执行 curl 命中 skill-bridge（身份/鉴权由 proxy 注入，body 只传业务字段）。",
    renderPlatformHint(tools),
    `调用：curl -sSk -X POST <bridge>/<action> -H 'content-type: application/json'${authHeader} -d '{...业务字段...}'（用客户端注册的 shell 工具执行；Windows PowerShell 下命令以 curl.exe 开头）`,
    `其中 <bridge> = ${bridge}`,
    "",
    "可用工具：",
    "",
    ...readTools,
    ...(allowLlmWrite ? [""] : []),
    ...(allowLlmWrite ? writeTools : []),
    "",
    note,
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
  cacheVersion = "2";
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
    const t = resolveInjectionTuning(this.config.tuning, ctx.metadata.agentSource);
    if (t.skillTools === false) return [];
    return this.renderBlocks(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.skill === false) return [];
    const t = resolveInjectionTuning(this.config.tuning, undefined);
    if (t.skillTools === false) return [];
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

    const content = renderSkillToolsBlock(this.config.proxyBaseUrl, allowLlmWrite, sessionId, spaceId, ctx?.tools);
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
