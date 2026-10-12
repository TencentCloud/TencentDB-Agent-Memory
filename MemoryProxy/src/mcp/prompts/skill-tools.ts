/**
 * MCP skill 工具描述文本与错误提示。
 *
 * 规范：与 MemoryCore/src/core/skill/prompts/ 同形，描述字符串统一在此文件
 * 维护，与工具注册逻辑（server.ts）解耦，便于独立修改措辞。
 *
 * 导出命名约定：
 *   - 工具描述：<TOOL_NAME>_DESCRIPTION
 *   - 参数描述：<TOOL_NAME>_PARAMS
 *   - 错误提示（动态）：<TOOL_NAME>_ERR_<REASON>（函数形式）
 */

// ── skill_search ─────────────────────────────────────────────────────────────

export const SKILL_SEARCH_DESCRIPTION =
  "Search skills by keyword using semantic retrieval. " +
  "Returns a summary list (name / description / version / score / snippet). " +
  "top_k defaults to 10, maximum 50.";

export const SKILL_SEARCH_PARAMS = {
  query: "Search keyword",
  top_k: "Maximum number of results to return (1–50, default 10)",
} as const;

/** skill_search 返回空时的提示，引导用户检查身份或换关键词。 */
export const SKILL_SEARCH_EMPTY = (
  query: string,
  agentId: string | undefined,
  teamId: string,
): string => {
  const agentPart = agentId
    ? `agent_id="${agentId}"`
    : "no agent_id (check X-Agent-Id header or mcp.agentId config)"
  return (
    `No skills found for query="${query}" with ${agentPart}, team_id="${teamId}". ` +
    `Skills are scoped per agent — if this is unexpected, verify your MCP client ` +
    `headers (X-Agent-Id / X-Team-Id) or the server-side mcp.agentId / mcp.teamId config. ` +
    `Otherwise, try a different keyword.`
  )
};

// ── skill_get ────────────────────────────────────────────────────────────────

export const SKILL_GET_DESCRIPTION =
  "Retrieve skill metadata and full SKILL.md content by skill_name (preferred) or skill_id. " +
  "At least one of skill_name or skill_id must be provided.";

export const SKILL_GET_PARAMS = {
  skill_name: "Skill name (preferred)",
  skill_id: "Skill ID — used when skill_name is not provided",
  include_content: "Whether to return the full SKILL.md content (default true)",
} as const;

// ── skill_read_file ──────────────────────────────────────────────────────────

export const SKILL_READ_FILE_DESCRIPTION =
  "Read the content of an attached file inside a skill by skill_id + path " +
  "(e.g. SKILL.md, config.yaml). version defaults to the head version. " +
  "PREREQUISITE: only meaningful when the manifest field returned by skill_get is non-empty. " +
  "An empty manifest means the skill has no attached files — calling this tool will return " +
  "a not-found error. path must be taken from the manifest file list.";

export const SKILL_READ_FILE_PARAMS = {
  skill_id: "Skill ID",
  path: "File path within the skill (e.g. SKILL.md)",
  version: "Version number (defaults to head version)",
} as const;

/** 文件不存在时的错误提示，引导调用方先检查 manifest。 */
export const SKILL_READ_FILE_ERR_NOT_FOUND = (path: string, skillId: string): string =>
  `File not found: ${path} (skill_id=${skillId}). ` +
  `Check the manifest field from skill_get first — an empty manifest means this skill has no attached files.`;
