/**
 * Unit tests for MCP 模块：
 *   - llm-coerce: tolerantParse 参数容错
 *   - identity: resolveIdentity / resolveServiceId 身份解析
 *   - mcp/server: createMcpServer 工具注册（tool list + 注解验证）
 *   - mcp/handler: createMcpHandler Auth 鉴权流程（4 路径）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// 1. llm-coerce
// ─────────────────────────────────────────────────────────────────────────────

import { tolerantParse } from "../mcp/llm-coerce.js";

describe("tolerantParse", () => {
  const KEYS = new Set(["query", "top_k"]);

  it("保留 allowedKeys 中的字段", () => {
    const result = tolerantParse({ query: "test", top_k: 5 }, KEYS);
    expect(result).toEqual({ query: "test", top_k: 5 });
  });

  it("剥离未声明的多余字段", () => {
    const result = tolerantParse({ query: "test", top_k: 5, explanation: "extra" }, KEYS);
    expect(result).not.toHaveProperty("explanation");
  });

  it("将字符串数字矫正为 number", () => {
    const result = tolerantParse({ query: "x", top_k: "10" }, KEYS);
    expect(result.top_k).toBe(10);
  });

  it("将字符串 JSON 数组矫正为数组", () => {
    const keys = new Set(["arr"]);
    const result = tolerantParse({ arr: '["a","b"]' }, keys);
    expect(result.arr).toEqual(["a", "b"]);
  });

  it("将字符串 JSON 对象矫正为对象", () => {
    const keys = new Set(["obj"]);
    const result = tolerantParse({ obj: '{"k":1}' }, keys);
    expect(result.obj).toEqual({ k: 1 });
  });

  it("将字符串 'true'/'false' 矫正为 boolean", () => {
    const keys = new Set(["flag"]);
    expect(tolerantParse({ flag: "true" }, keys).flag).toBe(true);
    expect(tolerantParse({ flag: "false" }, keys).flag).toBe(false);
  });

  it("非字符串值原样保留", () => {
    const result = tolerantParse({ query: "q", top_k: 3 }, KEYS);
    expect(result.top_k).toBe(3);
  });

  it("缺失字段不出现在结果中", () => {
    const result = tolerantParse({ query: "q" }, KEYS);
    expect(result).not.toHaveProperty("top_k");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. identity
// ─────────────────────────────────────────────────────────────────────────────

import { resolveIdentity, resolveServiceId } from "../mcp/identity.js";
import type { McpConfig } from "../types.js";

const BASE_MCP_CONFIG: McpConfig = {
  enabled: true,
  apiKey: "server-key",
  spaceId: "server-space",
  teamId: "server-team",
  agentId: "server-agent",
  userId: "server-user",
};

function makeHeaders(map: Record<string, string>) {
  return {
    get: (name: string) => map[name.toLowerCase()] ?? null,
  };
}

describe("resolveIdentity", () => {
  it("header 优先于 config", () => {
    const headers = makeHeaders({
      "x-team-id": "header-team",
      "x-agent-id": "header-agent",
      "x-user-id": "header-user",
    });
    const identity = resolveIdentity(headers, BASE_MCP_CONFIG);
    expect(identity.team_id).toBe("header-team");
    expect(identity.agent_id).toBe("header-agent");
    expect(identity.user_id).toBe("header-user");
  });

  it("header 缺失时 fallback 到 config", () => {
    const headers = makeHeaders({});
    const identity = resolveIdentity(headers, BASE_MCP_CONFIG);
    expect(identity.team_id).toBe("server-team");
    expect(identity.agent_id).toBe("server-agent");
    expect(identity.user_id).toBe("server-user");
  });

  it("config.agentId/userId 为空时结果中不带这些字段", () => {
    const cfg: McpConfig = { ...BASE_MCP_CONFIG, agentId: "", userId: "" };
    const identity = resolveIdentity(makeHeaders({}), cfg);
    expect(identity.agent_id).toBeUndefined();
    expect(identity.user_id).toBeUndefined();
  });

  it("team_id 两处都缺失时抛出 Error", () => {
    const cfg: McpConfig = { ...BASE_MCP_CONFIG, teamId: "" };
    expect(() => resolveIdentity(makeHeaders({}), cfg)).toThrow();
  });
});

describe("resolveServiceId", () => {
  it("X-Space-Id header 优先", () => {
    const headers = makeHeaders({ "x-space-id": "header-space" });
    expect(resolveServiceId(headers, BASE_MCP_CONFIG)).toBe("header-space");
  });

  it("header 缺失时 fallback 到 config.spaceId", () => {
    expect(resolveServiceId(makeHeaders({}), BASE_MCP_CONFIG)).toBe("server-space");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. createMcpServer — tool list 与注解
// ─────────────────────────────────────────────────────────────────────────────

import { createMcpServer } from "../mcp/server.js";

/** 最小化 CoreSkillClient mock */
function makeMockSkillClient() {
  return {
    searchSkills: vi.fn().mockResolvedValue({ items: [] }),
    post: vi.fn().mockResolvedValue({}),
  };
}

/** 带可控返回值的 mock，用于字段裁剪测试 */
function makeMockSkillClientWithPost(postImpl: (path: string, body: unknown) => unknown) {
  return {
    searchSkills: vi.fn(),
    post: vi.fn(async (path: string, body: unknown) => postImpl(path, body)),
  };
}

/**
 * McpServer 将注册的工具存储在私有 `_registeredTools` 对象中。
 * 通过类型断言访问它来验证注册结果，避免依赖 JSON-RPC 层（需要 transport 连接）。
 */
function getRegisteredTools(server: ReturnType<typeof createMcpServer>) {
  return (server as unknown as {
    _registeredTools: Record<string, {
      description?: string;
      annotations?: Record<string, unknown>;
    }>;
  })._registeredTools;
}

describe("createMcpServer", () => {
  it("注册恰好 5 个工具", () => {
    const server = createMcpServer(makeMockSkillClient() as never, { team_id: "t1" });
    const tools = getRegisteredTools(server);
    expect(Object.keys(tools)).toHaveLength(5);
  });

  it("所有工具均带 readOnlyHint=true", () => {
    const server = createMcpServer(makeMockSkillClient() as never, { team_id: "t1" });
    const tools = getRegisteredTools(server);
    for (const tool of Object.values(tools)) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("所有工具均带 openWorldHint=false", () => {
    const server = createMcpServer(makeMockSkillClient() as never, { team_id: "t1" });
    const tools = getRegisteredTools(server);
    for (const tool of Object.values(tools)) {
      expect(tool.annotations?.openWorldHint).toBe(false);
    }
  });

  it("工具名包含 5 个已注册工具", () => {
    const server = createMcpServer(makeMockSkillClient() as never, { team_id: "t1" });
    const names = Object.keys(getRegisteredTools(server));
    expect(names).toContain("skill_search");
    expect(names).toContain("skill_get");
    expect(names).toContain("skill_read_file");
    expect(names).toContain("memory_scene_ls");
    expect(names).toContain("memory_scene_read");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3b. 工具回调行为 — 字段裁剪 + 空结果提示
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 _registeredTools 提取工具回调函数。
 * registerTool 的 callback 被存在 registeredTool.handler 中。
 */
function getToolCallback(
  server: ReturnType<typeof createMcpServer>,
  toolName: string,
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const tools = getRegisteredTools(server as never) as unknown as Record<
    string,
    { handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
  >;
  const tool = tools[toolName];
  if (!tool?.handler) throw new Error(`Tool ${toolName} not found or has no handler`);
  return tool.handler;
}

/** 提取 MCP 返回结构中的 text 字段并解析为对象。 */
function parseContentText(result: Record<string, unknown>): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

describe("skill_search — 字段裁剪 + 空结果提示", () => {
  const identity = { team_id: "team-x", agent_id: "agt-x" };

  it("返回仅保留 skill_id / name / description / snippet / score 五个字段", async () => {
    const client = makeMockSkillClientWithPost(() => ({})) as never;
    client.searchSkills = vi.fn().mockResolvedValue({
      items: [{
        skill_id: "skl-1",
        name: "test-skill",
        description: "desc",
        snippet: "highlight",
        score: 0.95,
        // 这些字段应被裁掉
        version: 2,
        is_head: true,
        status: "active",
        team_id: "team-x",
        owner_user_id: "usr-x",
        owner_agent_id: "agt-x",
        task_id: "task-1",
        created_at_ms: 123,
        updated_at_ms: 456,
      }],
    });
    const server = createMcpServer(client, identity);
    const cb = getToolCallback(server, "skill_search");
    const result = await cb({ query: "test", top_k: 5 }) as Record<string, unknown>;
    expect(result.isError).toBeFalsy();
    const items = parseContentText(result) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    const keys = Object.keys(items[0]).sort();
    expect(keys).toEqual(["description", "name", "score", "skill_id", "snippet"]);
  });

  it("搜索结果为空时返回 isError + 包含 agent_id 的提示", async () => {
    const client = makeMockSkillClientWithPost(() => ({})) as never;
    client.searchSkills = vi.fn().mockResolvedValue({ items: [] });
    const server = createMcpServer(client, identity);
    const cb = getToolCallback(server, "skill_search");
    const result = await cb({ query: "nope" }) as Record<string, unknown>;
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("agt-x");
    expect(text).toContain("team-x");
  });
});

describe("skill_get — 字段裁剪", () => {
  const identity = { team_id: "team-x", agent_id: "agt-x" };

  it("返回仅保留 skill_id / name / description / manifest (+ content 有则保留)", async () => {
    const client = makeMockSkillClientWithPost((_path, _body) => ({
      skill_id: "skl-1",
      name: "test-skill",
      description: "desc",
      manifest: [{ path: "SKILL.md" }],
      content: "# full content",
      // 被裁掉
      version: 2,
      is_head: true,
      status: "active",
      team_id: "team-x",
      owner_user_id: "usr-x",
      owner_agent_id: "agt-x",
      task_id: "task-1",
      created_at_ms: 123,
      updated_at_ms: 456,
      content_hash: "abc",
      storage_dir: "skills/skl-1/v2",
    })) as never;
    const server = createMcpServer(client, identity);
    const cb = getToolCallback(server, "skill_get");
    const result = await cb({ skill_id: "skl-1" }) as Record<string, unknown>;
    expect(result.isError).toBeFalsy();
    const cleaned = parseContentText(result) as Record<string, unknown>;
    const keys = Object.keys(cleaned).sort();
    expect(keys).toEqual(["content", "description", "manifest", "name", "skill_id"]);
  });

  it("include_content=false 时 content 字段不出现", async () => {
    const client = makeMockSkillClientWithPost(() => ({
      skill_id: "skl-1",
      name: "test-skill",
      description: "desc",
      manifest: [],
    })) as never;
    const server = createMcpServer(client, identity);
    const cb = getToolCallback(server, "skill_get");
    const result = await cb({ skill_id: "skl-1", include_content: false }) as Record<string, unknown>;
    const cleaned = parseContentText(result) as Record<string, unknown>;
    expect(cleaned).not.toHaveProperty("content");
  });

  it("skill_name 和 skill_id 均缺失时返回 isError", async () => {
    const client = makeMockSkillClient() as never;
    const server = createMcpServer(client, identity);
    const cb = getToolCallback(server, "skill_get");
    const result = await cb({}) as Record<string, unknown>;
    expect(result.isError).toBe(true);
  });
});

describe("memory_scene_ls — 字段裁剪 + 空结果提示", () => {
  const identity = { team_id: "team-x", agent_id: "agt-x" };

  it("返回仅保留 path / summary，不包含 total / version / created_at 等", async () => {
    const client = makeMockSkillClientWithPost(() => ({
      entries: [{
        path: "work/delivery.md",
        summary: "summary text",
        version: 3,
        team_id: "team-x",
        agent_id: "agt-x",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
      }],
      total: 1,
    })) as never;
    const server = createMcpServer(client, identity);
    const cb = getToolCallback(server, "memory_scene_ls");
    const result = await cb({}) as Record<string, unknown>;
    expect(result.isError).toBeFalsy();
    const entries = parseContentText(result) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    const keys = Object.keys(entries[0]).sort();
    expect(keys).toEqual(["path", "summary"]);
  });

  it("返回空 entries 时返回 isError + 包含 agent_id 的提示", async () => {
    const client = makeMockSkillClientWithPost(() => ({
      entries: [],
      total: 0,
    })) as never;
    const server = createMcpServer(client, identity);
    const cb = getToolCallback(server, "memory_scene_ls");
    const result = await cb({}) as Record<string, unknown>;
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("agt-x");
    expect(text).toContain("team-x");
  });

  it("path_prefix 传入时提示中包含该前缀", async () => {
    const client = makeMockSkillClientWithPost(() => ({
      entries: [],
      total: 0,
    })) as never;
    const server = createMcpServer(client, identity);
    const cb = getToolCallback(server, "memory_scene_ls");
    const result = await cb({ path_prefix: "work/" }) as Record<string, unknown>;
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('"work/"');
  });
});

describe("memory_scene_read — 返回纯文本内容", () => {
  const identity = { team_id: "team-x", agent_id: "agt-x" };

  it("只返回 content 文本，不返回 version / path 等元数据", async () => {
    const client = makeMockSkillClientWithPost(() => ({
      path: "work/scene.md",
      content: "# Scene content",
      version: "v3",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    })) as never;
    const server = createMcpServer(client, identity);
    const cb = getToolCallback(server, "memory_scene_read");
    const result = await cb({ path: "work/scene.md" }) as Record<string, unknown>;
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toBe("# Scene content");
  });

  it("not found 错误返回 isError + 引导提示", async () => {
    const client = makeMockSkillClientWithPost(() => {
      throw new Error("HTTP 404: not found");
    }) as never;
    const server = createMcpServer(client, identity);
    const cb = getToolCallback(server, "memory_scene_read");
    const result = await cb({ path: "missing.md" }) as Record<string, unknown>;
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("missing.md");
    expect(text).toContain("memory_scene_ls");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. createMcpHandler — Auth 鉴权流程（4 路径）
// ─────────────────────────────────────────────────────────────────────────────
const mockVerifyUserKey = vi.hoisted(() => vi.fn());
vi.mock("../auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth.js")>()),
  verifyUserKey: mockVerifyUserKey,
}));

// Mock getCoreSkillClient to avoid needing a real CoreSkill config
const mockGetCoreSkillClient = vi.hoisted(() => vi.fn());
vi.mock("../skill/core-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skill/core-client.js")>()),
  getCoreSkillClient: mockGetCoreSkillClient,
}));

// Mock enforceRateLimit
const mockEnforceRateLimit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../rate-limit/guard.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../rate-limit/guard.js")>();
  return {
    ...orig,
    enforceRateLimit: mockEnforceRateLimit,
  };
});

import { createMcpHandler } from "../mcp/handler.js";
import { DEFAULT_CONFIG } from "../config.js";

function makeMcpConfig(): McpConfig {
  return {
    enabled: true,
    apiKey: "default-key",
    spaceId: "spc-001",
    teamId: "team-001",
    agentId: "",
    userId: "",
  };
}

function makeHandlerConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  (config as typeof config & { mcp: McpConfig }).mcp = makeMcpConfig();
  return config as typeof config & { mcp: McpConfig };
}

function makeHonoContext(opts: {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}) {
  const method = opts.method ?? "POST";
  const headers = new Headers({
    "content-type": "application/json",
    ...opts.headers,
  });
  // GET/HEAD/DELETE cannot have a body (Fetch spec)
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "DELETE";
  const body = hasBody
    ? (opts.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
    : undefined;
  const req = new Request("http://localhost/mcp", {
    method,
    headers,
    body,
  });
  return {
    req: {
      method,
      header: (name: string) => headers.get(name) ?? undefined,
      raw: req,
    },
  } as unknown as import("hono").Context;
}

describe("createMcpHandler — 鉴权路径", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCoreSkillClient.mockReturnValue(makeMockSkillClient());
    mockEnforceRateLimit.mockResolvedValue(undefined);
  });

  it("GET → 405", async () => {
    const handler = createMcpHandler(makeHandlerConfig());
    const c = makeHonoContext({ method: "GET", body: undefined });
    const resp = await handler(c);
    expect(resp.status).toBe(405);
  });

  it("DELETE → 405", async () => {
    const handler = createMcpHandler(makeHandlerConfig());
    const c = makeHonoContext({ method: "DELETE", body: undefined });
    const resp = await handler(c);
    expect(resp.status).toBe(405);
  });

  it("auth 拒绝时 → 401", async () => {
    mockVerifyUserKey.mockResolvedValueOnce({
      userId: "",
      rejected: true,
      rejectReason: "invalid key",
    });

    const handler = createMcpHandler(makeHandlerConfig());
    const c = makeHonoContext({
      headers: { authorization: "Bearer bad-key" },
    });
    const resp = await handler(c);
    expect(resp.status).toBe(401);
  });

  it("auth 拒绝时不调用 enforceRateLimit（鉴权先于限流）", async () => {
    mockVerifyUserKey.mockResolvedValueOnce({
      userId: "",
      rejected: true,
      rejectReason: "invalid key",
    });

    const handler = createMcpHandler(makeHandlerConfig());
    await handler(makeHonoContext({ headers: { authorization: "Bearer bad-key" } }));

    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it("auth 通过后调用 enforceRateLimit（限流在鉴权之后）", async () => {
    mockVerifyUserKey.mockResolvedValueOnce({ userId: "u1", rejected: false });

    const handler = createMcpHandler(makeHandlerConfig());
    await handler(makeHonoContext({}));

    expect(mockEnforceRateLimit).toHaveBeenCalled();
  });

  it("Bearer header 中的 key 传给 verifyUserKey", async () => {
    mockVerifyUserKey.mockResolvedValueOnce({ userId: "u1", rejected: false });

    const handler = createMcpHandler(makeHandlerConfig());
    const c = makeHonoContext({
      headers: { authorization: "Bearer client-key" },
    });
    await handler(c);

    expect(mockVerifyUserKey).toHaveBeenCalledWith("client-key", expect.any(String));
  });

  it("无 Bearer header 时使用 config.mcp.apiKey 作为 fallback", async () => {
    mockVerifyUserKey.mockResolvedValueOnce({ userId: "u1", rejected: false });

    const handler = createMcpHandler(makeHandlerConfig());
    const c = makeHonoContext({}); // no authorization header
    await handler(c);

    expect(mockVerifyUserKey).toHaveBeenCalledWith("default-key", expect.any(String));
  });

  it("team_id 缺失时 → 400", async () => {
    mockVerifyUserKey.mockResolvedValueOnce({ userId: "u1", rejected: false });

    const config = makeHandlerConfig();
    config.mcp.teamId = ""; // 删掉 server 侧 teamId

    const handler = createMcpHandler(config);
    // 也没有 X-Team-Id header
    const c = makeHonoContext({});
    const resp = await handler(c);
    expect(resp.status).toBe(400);
  });

  it("RateLimitExceededError → 429", async () => {
    mockVerifyUserKey.mockResolvedValueOnce({ userId: "u1", rejected: false });

    // Import and use the real class from the mock
    const { RateLimitExceededError } = await import("../rate-limit/guard.js");
    const rateLimitResp = new Response(JSON.stringify({ error: "rate_limit" }), { status: 429 });
    mockEnforceRateLimit.mockRejectedValueOnce(new RateLimitExceededError(rateLimitResp));

    const handler = createMcpHandler(makeHandlerConfig());
    const resp = await handler(makeHonoContext({}));
    expect(resp.status).toBe(429);
  });
});
