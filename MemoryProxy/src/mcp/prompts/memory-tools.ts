/**
 * MCP memory 工具描述文本与错误提示。
 *
 * 覆盖 L0（对话历史）、L1（原子记忆）、L2（场景块）、L3（persona）四层。
 * 当前实现：L2 场景块（memory_scene_ls / memory_scene_read）。
 * 后续扩展：L1（memory_atomic_search）、L3（memory_persona_read）按相同规范在本文件追加。
 *
 * 导出命名约定：
 *   - 工具描述：<TOOL_NAME>_DESCRIPTION
 *   - 参数描述：<TOOL_NAME>_PARAMS
 *   - 错误提示（动态）：<TOOL_NAME>_ERR_<REASON>（函数形式）
 */

// ── memory_scene_ls (L2) ──────────────────────────────────────────────────────

export const MEMORY_SCENE_LS_DESCRIPTION =
  "List L2 scene block file paths for the current agent. " +
  "Returns a directory index (path / version / updated_at) without file content. " +
  "Use memory_scene_read to fetch the full content of a specific scene. " +
  "path_prefix filters results to a subtree (e.g. \"work/\"); omit to list all scenes.";

export const MEMORY_SCENE_LS_PARAMS = {
  path_prefix:
    "Optional path prefix to filter results (e.g. \"work/\"). Omit to list all scenes.",
} as const;

// ── memory_scene_read (L2) ────────────────────────────────────────────────────

export const MEMORY_SCENE_READ_DESCRIPTION =
  "Read the full content of a single L2 scene block file by path. " +
  "path must be obtained from memory_scene_ls — do not guess paths. " +
  "Returns the scene file content (Markdown) along with its version and timestamps.";

export const MEMORY_SCENE_READ_PARAMS = {
  path: "Scene file path as returned by memory_scene_ls (e.g. \"work/delivery/2026Q1.md\").",
} as const;

/** 场景文件不存在时的错误提示。 */
export const MEMORY_SCENE_READ_ERR_NOT_FOUND = (path: string): string =>
  `Scene file not found: ${path}. ` +
  `Use memory_scene_ls to list available scene paths first.`

/** memory_scene_ls 返回空时的提示，引导用户检查身份配置。 */
export const MEMORY_SCENE_LS_EMPTY = (
  agentId: string | undefined,
  teamId: string,
  pathPrefix?: string,
): string => {
  const scope = pathPrefix ? ` under prefix "${pathPrefix}"` : ""
  const agentPart = agentId ? `agent_id="${agentId}"` : "no agent_id (check X-Agent-Id header or mcp.agentId config)"
  return (
    `No L2 scene blocks found${scope} for ${agentPart}, team_id="${teamId}". ` +
    `If this is unexpected, verify your MCP client headers (X-Agent-Id / X-Team-Id) ` +
    `or the server-side mcp.agentId / mcp.teamId config. ` +
    `An empty result usually means the configured agent has no scene blocks yet, ` +
    `or the identity is misconfigured.`
  )
}

// ── L1 / L3 — reserved for future tools ──────────────────────────────────────
// memory_atomic_search  (L1): search atomic memories by keyword
// memory_persona_read   (L3): read long-term persona profile
