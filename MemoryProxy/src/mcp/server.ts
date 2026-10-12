/**
 * MCP Server 工厂——注册只读工具集（skill + memory）。
 *
 * 工厂函数 `createMcpServer(skillClient, identity)` 每次请求创建一个新实例
 * （无状态模式），注入调用者身份，避免状态泄漏。
 *
 * 工具集（全部标注 readOnlyHint + openWorldHint: false）：
 *
 *   Skill 工具：
 *   - skill_search    : 按 query 检索 skill
 *   - skill_get       : 按 skill_name（优先）或 skill_id 读取 skill 元数据与内容
 *   - skill_read_file : 按 skill_id + path 读取 skill 内指定文件
 *
 *   Memory 工具（L2 场景块，后续扩展 L1/L3）：
 *   - memory_scene_ls   : 列出当前 agent 的 L2 场景块路径索引
 *   - memory_scene_read : 按 path 读取单个 L2 场景块全文
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { CoreSkillClient } from "../skill/core-client.js";
import type { McpIdentity } from "./identity.js";
import { tolerantParse } from "./llm-coerce.js";
import {
  SKILL_SEARCH_DESCRIPTION,
  SKILL_SEARCH_PARAMS,
  SKILL_SEARCH_EMPTY,
  SKILL_GET_DESCRIPTION,
  SKILL_GET_PARAMS,
  SKILL_READ_FILE_DESCRIPTION,
  SKILL_READ_FILE_PARAMS,
  SKILL_READ_FILE_ERR_NOT_FOUND,
} from "./prompts/skill-tools.js";
import {
  MEMORY_SCENE_LS_DESCRIPTION,
  MEMORY_SCENE_LS_PARAMS,
  MEMORY_SCENE_LS_EMPTY,
  MEMORY_SCENE_READ_DESCRIPTION,
  MEMORY_SCENE_READ_PARAMS,
  MEMORY_SCENE_READ_ERR_NOT_FOUND,
} from "./prompts/memory-tools.js";

const SERVER_NAME = "tdai-memory-proxy";
const SERVER_VERSION = "1.0.0";

// ── 工具名 ────────────────────────────────────────────────────────────────────

const TOOL_SKILL_SEARCH = "skill_search";
const TOOL_SKILL_GET = "skill_get";
const TOOL_SKILL_READ_FILE = "skill_read_file";
const TOOL_MEMORY_SCENE_LS = "memory_scene_ls";
const TOOL_MEMORY_SCENE_READ = "memory_scene_read";

// ── 各工具 schema 声明的合法字段（供 tolerantParse 剥离多余参数） ─────────────

const SEARCH_KEYS = new Set(["query", "top_k"]);
const GET_KEYS = new Set(["skill_name", "skill_id", "include_content"]);
const READ_FILE_KEYS = new Set(["skill_id", "path", "version"]);
const SCENE_LS_KEYS = new Set(["path_prefix"]);
const SCENE_READ_KEYS = new Set(["path"]);

// ── 工具 inputSchema（Zod v4）────────────────────────────────────────────────

const SearchInput = z.object({
  query: z.string().describe(SKILL_SEARCH_PARAMS.query),
  top_k: z.number().int().min(1).max(50).optional().describe(SKILL_SEARCH_PARAMS.top_k),
});

const GetInput = z.object({
  skill_name: z.string().optional().describe(SKILL_GET_PARAMS.skill_name),
  skill_id: z.string().optional().describe(SKILL_GET_PARAMS.skill_id),
  include_content: z.boolean().optional().describe(SKILL_GET_PARAMS.include_content),
});

const ReadFileInput = z.object({
  skill_id: z.string().describe(SKILL_READ_FILE_PARAMS.skill_id),
  path: z.string().describe(SKILL_READ_FILE_PARAMS.path),
  version: z.number().int().min(1).optional().describe(SKILL_READ_FILE_PARAMS.version),
});

const SceneLsInput = z.object({
  path_prefix: z.string().optional().describe(MEMORY_SCENE_LS_PARAMS.path_prefix),
});

const SceneReadInput = z.object({
  path: z.string().describe(MEMORY_SCENE_READ_PARAMS.path),
});

// ── 公共工具注解 ──────────────────────────────────────────────────────────────

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true as const,
  openWorldHint: false as const,
};

// ── 工厂函数 ──────────────────────────────────────────────────────────────────

/**
 * 创建一个全新的 McpServer 实例，注入本次请求的调用身份与 skill client。
 *
 * 每个 HTTP 请求应调用此函数创建独立实例，确保无状态且身份隔离。
 */
export function createMcpServer(
  skillClient: CoreSkillClient,
  identity: McpIdentity,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
  );

  // ── skill_search ────────────────────────────────────────────────────────────

  server.registerTool(
    TOOL_SKILL_SEARCH,
    {
      title: "Search Skills",
      description: SKILL_SEARCH_DESCRIPTION,
      inputSchema: SearchInput.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (rawArgs) => {
      const args = tolerantParse(rawArgs as Record<string, unknown>, SEARCH_KEYS);
      const parsed = SearchInput.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        };
      }

      try {
        const result = await skillClient.searchSkills({
          ...identity,
          query: parsed.data.query,
          top_k: parsed.data.top_k ?? 10,
        });
        const items = (result.items ?? []).map((item: Record<string, unknown>) => ({
          skill_id: item.skill_id,
          name: item.name,
          description: item.description,
          snippet: item.snippet,
          score: item.score,
        }));
        if (items.length === 0) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: SKILL_SEARCH_EMPTY(parsed.data.query, identity.agent_id, identity.team_id),
            }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `skill_search failed: ${(err as Error).message}` }],
        };
      }
    },
  );

  // ── skill_get ───────────────────────────────────────────────────────────────

  server.registerTool(
    TOOL_SKILL_GET,
    {
      title: "Get Skill",
      description: SKILL_GET_DESCRIPTION,
      inputSchema: GetInput.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (rawArgs) => {
      const args = tolerantParse(rawArgs as Record<string, unknown>, GET_KEYS);
      const parsed = GetInput.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        };
      }

      const { skill_name, skill_id, include_content = true } = parsed.data;
      if (!skill_name && !skill_id) {
        return {
          isError: true,
          content: [{ type: "text", text: "skill_name or skill_id must be provided" }],
        };
      }

      try {
        let result: unknown;
        if (skill_name) {
          // 优先 get-by-name；核心 API 字段名为 skill_name，不是 name
          result = await skillClient.post(
            "/v3/skill/get-by-name",
            { ...identity, skill_name, include_content },
          );
        } else {
          result = await skillClient.post(
            "/v3/skill/get",
            { ...identity, skill_id, include_content },
          );
        }
        const r = result as Record<string, unknown>;
        const cleaned: Record<string, unknown> = {
          skill_id: r.skill_id,
          name: r.name,
          description: r.description,
          manifest: r.manifest,
        };
        if (r.content !== undefined) cleaned.content = r.content;
        return {
          content: [{ type: "text", text: JSON.stringify(cleaned, null, 2) }],
        };
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (msg.includes("40401") || msg.includes("not found") || msg.includes("不存在")) {
          return {
            isError: true,
            content: [{ type: "text", text: `Skill not found: ${msg}` }],
          };
        }
        return {
          isError: true,
          content: [{ type: "text", text: `skill_get failed: ${msg}` }],
        };
      }
    },
  );

  // ── skill_read_file ─────────────────────────────────────────────────────────

  server.registerTool(
    TOOL_SKILL_READ_FILE,
    {
      title: "Read Skill File",
      description: SKILL_READ_FILE_DESCRIPTION,
      inputSchema: ReadFileInput.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (rawArgs) => {
      const args = tolerantParse(rawArgs as Record<string, unknown>, READ_FILE_KEYS);
      const parsed = ReadFileInput.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        };
      }

      const { skill_id, path: filePath, version } = parsed.data;

      try {
        const result = await skillClient.post<{ content: string; path: string }>(
          "/v3/skill/files/read",
          { ...identity, skill_id, path: filePath, ...(version != null ? { version } : {}) },
        );
        return {
          content: [{ type: "text", text: result.content ?? "" }],
        };
      } catch (err) {
        const msg = (err as Error).message ?? "";
        const isNotFound =
          msg.includes("40401") ||
          msg.includes("not found") ||
          msg.includes("不存在") ||
          msg.includes("no such file");
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: isNotFound
                ? SKILL_READ_FILE_ERR_NOT_FOUND(filePath, skill_id)
                : `skill_read_file failed: ${msg}`,
            },
          ],
        };
      }
    },
  );

  // ── memory_scene_ls (L2) ────────────────────────────────────────────────────

  server.registerTool(
    TOOL_MEMORY_SCENE_LS,
    {
      title: "List Memory Scenes",
      description: MEMORY_SCENE_LS_DESCRIPTION,
      inputSchema: SceneLsInput.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (rawArgs) => {
      const args = tolerantParse(rawArgs as Record<string, unknown>, SCENE_LS_KEYS);
      const parsed = SceneLsInput.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        };
      }

      const { path_prefix } = parsed.data;

      try {
        const result = await skillClient.post<{ entries: unknown[]; total: number }>(
          "/v3/scenario/ls",
          { ...identity, ...(path_prefix != null ? { path_prefix } : {}) },
        );
        const entries = ((result.entries ?? []) as Record<string, unknown>[]).map((e) => ({
          path: e.path,
          summary: e.summary,
        }));
        if (entries.length === 0) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: MEMORY_SCENE_LS_EMPTY(identity.agent_id, identity.team_id, path_prefix),
            }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `memory_scene_ls failed: ${(err as Error).message}` }],
        };
      }
    },
  );

  // ── memory_scene_read (L2) ──────────────────────────────────────────────────

  server.registerTool(
    TOOL_MEMORY_SCENE_READ,
    {
      title: "Read Memory Scene",
      description: MEMORY_SCENE_READ_DESCRIPTION,
      inputSchema: SceneReadInput.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (rawArgs) => {
      const args = tolerantParse(rawArgs as Record<string, unknown>, SCENE_READ_KEYS);
      const parsed = SceneReadInput.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        };
      }

      const { path: scenePath } = parsed.data;

      try {
        const result = await skillClient.post<{ path: string; content: string; version: string }>(
          "/v3/scenario/read",
          { ...identity, path: scenePath },
        );
        return {
          content: [{ type: "text", text: result.content ?? "" }],
        };
      } catch (err) {
        const msg = (err as Error).message ?? "";
        const isNotFound =
          msg.includes("40401") ||
          msg.includes("not found") ||
          msg.includes("不存在") ||
          msg.includes("no such file");
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: isNotFound
                ? MEMORY_SCENE_READ_ERR_NOT_FOUND(scenePath)
                : `memory_scene_read failed: ${msg}`,
            },
          ],
        };
      }
    },
  );

  return server;
}
