/**
 * Tools Routes — Agent self-discovery HTTP endpoints.
 *
 * Two endpoints for the v7 progressive-exposure pattern:
 *   POST /tools/list — discover available tools for a knowledge resource
 *   POST /tools/call — execute a tool on a knowledge resource
 *
 * Tools are defined per resource type (wiki / code-graph). Management operations
 * (create/delete/ingest/sync) are NOT exposed — only read-only query tools.
 *
 * Routes are defined WITHOUT /v3 prefix — prefix applied at server.ts mount level.
 */

import { Hono } from "hono";

import type { WikiService, CodeGraphService } from "../store/index.js";
import type { CodeGraphInstancePool } from "../module.js";
import type { WikiSourceManager } from "../engines/wiki/index.js";
import { executeTool as executeCodeTool } from "../engines/code/index.js";
import { wrapOk, wrapError, isValidIdSegment } from "../api-helpers.js";
import { isWikiId, isCodeGraphId } from "../store/ids.js";

export interface ToolsRouteDeps {
  wikiService: WikiService;
  wikiMgr: WikiSourceManager;
  cgService: CodeGraphService;
  instancePool: CodeGraphInstancePool;
}

// ═══════════════════════════════════════════════════════════════════════
//  Tool Registry — HTTP tool definitions (per resource type)
// ═══════════════════════════════════════════════════════════════════════

interface HttpToolParam {
  type: "string" | "integer" | "boolean" | "array";
  required?: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
}

interface HttpToolDef {
  name: string;
  description: string;
  params: Record<string, HttpToolParam>;
}

/** Wiki tools (7) — read-only query tools for LLM agents. */
const WIKI_TOOLS: HttpToolDef[] = [
  {
    name: "get_info",
    description: "获取 wiki 元信息（名称、状态、页面数等）。",
    params: {},
  },
  {
    name: "search",
    description: "BM25 全文搜索 wiki 页面内容。用关键词查找相关文档。",
    params: {
      query: { type: "string", required: true, description: "搜索关键词" },
      limit: { type: "integer", required: false, default: 20, description: "返回结果数上限" },
    },
  },
  {
    name: "list_pages",
    description: "列出所有页面引用（id + title + path）。",
    params: {},
  },
  {
    name: "read_page",
    description: "读取指定页面完整内容。",
    params: {
      refs: { type: "array", required: true, description: "页面引用数组（id 或路径）" },
    },
  },
  {
    name: "get_graph",
    description: "获取知识图谱结构（nodes, edges）。communities 字段保留但未实现（恒为空）。",
    params: {},
  },
  {
    name: "list_raw",
    description: "列出原始上传文件。",
    params: {},
  },
  {
    name: "read_raw",
    description: "读取指定原始文件内容。",
    params: {
      filenames: { type: "array", required: true, description: "文件名数组" },
    },
  },
];

/** Code-Graph tools (9) — read-only query tools for LLM agents. */
const CODE_GRAPH_TOOLS: HttpToolDef[] = [
  {
    name: "get_info",
    description: "获取 code-graph 元信息（仓库名、状态、统计等）。",
    params: {},
  },
  {
    name: "search",
    description:
      "按名称快速搜索符号，只返回位置（不含源码）。想直接拿到源码/理解某块代码，请改用 explore。",
    params: {
      query: { type: "string", required: true, description: "符号名或部分名称（如 \"auth\"、\"signIn\"、\"UserService\"）" },
      kind: {
        type: "string",
        required: false,
        enum: ["function", "method", "class", "interface", "type", "variable", "route", "component"],
        description: "按节点类型过滤。省略则搜索全部类型（不要传 \"any\"/\"symbol\"/\"file\"，这些不是合法值，会导致零结果）。",
      },
      limit: { type: "integer", required: false, default: 10, description: "返回结果数上限" },
    },
  },
  {
    name: "explore",
    description:
      "【首选工具】几乎任何问题都先用它：X 怎么工作、架构、定位 bug、某处在哪。一次调用即按文件分组返回相关符号的完整源码（等价于 Read，返回的文件不要再重复读）。query 可以是自然语言问题，也可以是一组符号/文件名。通常一次就够，无需再 search/get_node/读文件。",
    params: {
      query: {
        type: "string",
        required: true,
        description: "要探索的符号名、文件名或简短代码词（如 \"AuthService loginUser session-manager\"）。可先用 search 找到相关名称。",
      },
      maxFiles: { type: "integer", required: false, default: 12, description: "最多返回源码的文件数（默认 12）" },
    },
  },
  {
    name: "callers",
    description: "列出调用 <symbol> 的函数。想看完整调用流程请用 explore。",
    params: {
      symbol: { type: "string", required: true, description: "要查调用者的函数/方法/类名" },
      limit: { type: "integer", required: false, default: 20, description: "返回结果数上限（默认 20）" },
    },
  },
  {
    name: "callees",
    description: "列出 <symbol> 调用的函数。想看完整调用流程请用 explore。",
    params: {
      symbol: { type: "string", required: true, description: "要查被调用者的函数/方法/类名" },
      limit: { type: "integer", required: false, default: 20, description: "返回结果数上限（默认 20）" },
    },
  },
  {
    name: "impact",
    description: "列出修改 <symbol> 会影响到的符号。重构前先用它评估影响面。",
    params: {
      symbol: { type: "string", required: true, description: "要做影响分析的符号名" },
      depth: { type: "integer", required: false, default: 2, description: "依赖遍历层数（默认 2）" },
    },
  },
  {
    name: "node",
    description:
      "【explore 之后的次选】获取单个符号的完整信息：位置、签名、调用链、以及逐字源码（includeCode=true）。名称有重载/多定义时会一次返回全部匹配定义的完整 body；可用 file/line 精确定位某个重载。需要多个相关符号或完整流程时请用 explore。",
    params: {
      symbol: { type: "string", required: true, description: "要查详情的符号名" },
      includeCode: { type: "boolean", required: false, default: false, description: "是否包含完整源码（默认 false 以节省上下文）" },
      file: { type: "string", required: false, description: "可选：用文件路径/文件名消歧重载（如 \"harness.rs\"）" },
      line: { type: "integer", required: false, description: "可选：用行号消歧到该位置附近的定义" },
    },
  },
  {
    name: "status",
    description: "索引健康检查（文件/节点/边数量）。除非排查问题，一般不需要。",
    params: {},
  },
  {
    name: "files",
    description: "索引到的文件树，含语言与符号数。查看项目结构比 Glob 更快。",
    params: {
      path: { type: "string", required: false, description: "按目录前缀过滤（如 \"src/components\"），不传则返回全部" },
      pattern: { type: "string", required: false, description: "按 glob 模式过滤（如 \"*.tsx\"、\"**/*.test.ts\"）" },
      format: { type: "string", required: false, default: "tree", enum: ["tree", "flat", "grouped"], description: "输出格式：tree（层级，默认）、flat（平铺列表）、grouped（按语言分组）" },
    },
  },
];

/** Agent read-only whitelist — management ops NOT included. */
const WIKI_TOOL_NAMES = new Set(WIKI_TOOLS.map((t) => t.name));
const CODE_GRAPH_TOOL_NAMES = new Set(CODE_GRAPH_TOOLS.map((t) => t.name));

// ═══════════════════════════════════════════════════════════════════════
//  Route Factory
// ═══════════════════════════════════════════════════════════════════════

export function createToolsRoutes(deps: ToolsRouteDeps): Hono {
  const app = new Hono();
  const { wikiService, wikiMgr, cgService, instancePool } = deps;

  // ── POST /tools/list ──

  app.post("/list", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    const knowledgeId = body.knowledge_id;
    if (typeof knowledgeId !== "string" || !knowledgeId) {
      return c.json(wrapError(400, "knowledge_id is required"), 400);
    }

    let type: "wiki" | "code-graph";
    let tools: HttpToolDef[];
    let name: string;
    let summary: string | null;
    let status: string;

    if (isWikiId(knowledgeId)) {
      type = "wiki";
      tools = WIKI_TOOLS;
      const row = wikiService.getById(serviceId, knowledgeId);
      if (!row) return c.json(wrapError(404, "knowledge resource not found"), 404);
      name = row.name;
      summary = row.summary ?? null;
      status = row.status;
    } else if (isCodeGraphId(knowledgeId)) {
      type = "code-graph";
      tools = CODE_GRAPH_TOOLS;
      const row = cgService.getById(serviceId, knowledgeId);
      if (!row) return c.json(wrapError(404, "knowledge resource not found"), 404);
      name = row.repo_name || row.repo_url;
      summary = row.summary ?? null;
      status = row.status;
    } else {
      return c.json(wrapError(400, `invalid knowledge_id format: ${knowledgeId}`), 400);
    }

    return c.json(wrapOk({
      knowledge_id: knowledgeId,
      type,
      name,
      summary,
      status,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        params: t.params,
      })),
    }));
  });

  // ── POST /tools/call ──

  app.post("/call", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    const knowledgeId = body.knowledge_id;
    if (typeof knowledgeId !== "string" || !knowledgeId) {
      return c.json(wrapError(400, "knowledge_id is required"), 400);
    }
    const toolName = body.tool_name;
    if (typeof toolName !== "string" || !toolName) {
      return c.json(wrapError(400, "tool_name is required"), 400);
    }
    const params = body.params;
    if (!params || typeof params !== "object") {
      return c.json(wrapError(400, "params is required (object)"), 400);
    }

    const toolParams = params as Record<string, unknown>;

    if (isWikiId(knowledgeId)) {
      // Whitelist check
      if (!WIKI_TOOL_NAMES.has(toolName)) {
        return c.json(wrapError(403, `unknown tool: '${toolName}' for wiki resource '${knowledgeId}'. Use tools/list to discover available tools.`), 403);
      }

      const row = wikiService.getById(serviceId, knowledgeId);
      if (!row) return c.json(wrapError(404, "wiki not found"), 404);

      return executeWikiTool(serviceId, toolName, row, toolParams, wikiService, wikiMgr);
    }

    if (isCodeGraphId(knowledgeId)) {
      // Whitelist check
      if (!CODE_GRAPH_TOOL_NAMES.has(toolName)) {
        return c.json(wrapError(403, `unknown tool: '${toolName}' for code-graph resource '${knowledgeId}'. Use tools/list to discover available tools.`), 403);
      }

      const row = cgService.getById(serviceId, knowledgeId);
      if (!row) return c.json(wrapError(404, "code graph not found"), 404);

      return executeCodeGraphTool(serviceId, toolName, row, toolParams, cgService, instancePool);
    }

    return c.json(wrapError(400, `invalid knowledge_id format: ${knowledgeId}`), 400);
  });

  return app;
}

// ═══════════════════════════════════════════════════════════════════════
//  Wiki tool execution
// ═══════════════════════════════════════════════════════════════════════

async function executeWikiTool(
  serviceId: string,
  toolName: string,
  row: { wiki_id: string; team_id: string; status: string; name: string },
  params: Record<string, unknown>,
  wikiService: WikiService,
  wikiMgr: WikiSourceManager,
): Promise<Response> {
  const { wiki_id, team_id } = row;

  switch (toolName) {
    case "get_info": {
      const detail = wikiService.get(serviceId, team_id, wiki_id);
      if (!detail) return Response.json(wrapError(404, "wiki not found"), { status: 404 });
      return Response.json(wrapOk(detail));
    }
    case "search": {
      const query = params.query;
      if (typeof query !== "string" || !query) {
        return Response.json(wrapError(400, "query is required"), { status: 400 });
      }
      if (row.status !== "ready") {
        return Response.json(wrapOk({ results: [], links: [], count: 0 }));
      }
      const limit = typeof params.limit === "number" ? params.limit : 20;
      const response = wikiMgr.search(wiki_id, query, limit);
      return Response.json(wrapOk(response));
    }
    case "list_pages": {
      if (row.status !== "ready") {
        return Response.json(wrapOk({ items: [] }));
      }
      const items = wikiService.pageLs(serviceId, team_id, wiki_id);
      if (items === null) return Response.json(wrapError(404, "wiki not found"), { status: 404 });
      return Response.json(wrapOk({ items }));
    }
    case "read_page": {
      const refs = params.refs;
      if (!Array.isArray(refs) || refs.length === 0) {
        return Response.json(wrapError(400, "refs is required (non-empty array)"), { status: 400 });
      }
      if (row.status !== "ready") {
        return Response.json(wrapOk({ items: [] }));
      }
      const result = wikiService.pageReadMany(serviceId, team_id, wiki_id, refs as string[]);
      return Response.json(wrapOk({ items: result }));
    }
    case "get_graph": {
      if (row.status !== "ready") {
        return Response.json(wrapOk({ nodes: [], edges: [], communities: [] }));
      }
      const graphData = wikiMgr.graph(wiki_id);
      return Response.json(wrapOk(graphData));
    }
    case "list_raw": {
      const items = wikiService.rawLs(serviceId, team_id, wiki_id);
      if (items === null) return Response.json(wrapError(404, "wiki not found"), { status: 404 });
      return Response.json(wrapOk({ items }));
    }
    case "read_raw": {
      const filenames = params.filenames;
      if (!Array.isArray(filenames) || filenames.length === 0) {
        return Response.json(wrapError(400, "filenames is required (non-empty array)"), { status: 400 });
      }
      const result = wikiService.rawReadMany(serviceId, team_id, wiki_id, filenames as string[]);
      return Response.json(wrapOk({ items: result }));
    }
    default:
      return Response.json(wrapError(403, `unknown tool: ${toolName}`), { status: 403 });
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Code-Graph tool execution
// ═══════════════════════════════════════════════════════════════════════

// Reuse the query specs from code-graph routes

/**
 * 对外暴露的 codegraph 查询工具名（不含 get_info，get_info 在调用方特殊处理）。
 * 单一真相源：tools.ts 的 CODE_GRAPH_TOOLS、code-graph.ts 的路由注册、
 * toCodeGraphToolName 的校验列表，全部从这里来。
 */
export const CODEGRAPH_QUERY_TOOL_NAMES: readonly string[] = [
  "search", "explore", "callers", "callees", "impact", "node", "status", "files",
];

/**
 * 把对外暴露的工具名映射为 executeTool 接受的内部工具名。
 * 对外统一用短名（node / status / files），内部统一加 codegraph_ 前缀。
 */
export function toCodeGraphToolName(externalName: string): string | undefined {
  return CODEGRAPH_QUERY_TOOL_NAMES.includes(externalName) ? `codegraph_${externalName}` : undefined;
}

async function executeCodeGraphTool(
  serviceId: string,
  toolName: string,
  row: { code_graph_id: string; team_id: string; status: string },
  params: Record<string, unknown>,
  cgService: CodeGraphService,
  instancePool: CodeGraphInstancePool,
): Promise<Response> {
  const { code_graph_id, team_id } = row;

  // get_info is a simple metadata return
  if (toolName === "get_info") {
    const detail = cgService.get(serviceId, team_id, code_graph_id);
    if (!detail) return Response.json(wrapError(404, "code graph not found"), { status: 404 });
    return Response.json(wrapOk(detail));
  }

  // All other tools require synced status
  if (row.status !== "ready") {
    return Response.json(wrapOk({ text: "", isError: false }));
  }

  // Map tool name to internal codegraph action
  const cgToolName = toCodeGraphToolName(toolName);
  if (!cgToolName) {
    return Response.json(wrapError(403, `unknown tool: ${toolName}`), { status: 403 });
  }

  // Build toolParams — map HTTP params to code-graph executeTool params
  const toolParams: Record<string, unknown> = { code_graph_id };
  for (const [k, v] of Object.entries(params)) {
    toolParams[k] = v;
  }

  let instance = instancePool.get(code_graph_id);
  if (!instance && instancePool.loadIfMissing) {
    const dir = cgService.dirFor(serviceId, team_id, code_graph_id);
    instance = await instancePool.loadIfMissing(code_graph_id, dir);
  }
  if (!instance) {
    return Response.json(wrapError(503, "code graph instance not loaded"), { status: 503 });
  }

  const result = await executeCodeTool(instance, cgToolName, toolParams);
  return Response.json(wrapOk(result), { status: result.isError ? 500 : 200 });
}
