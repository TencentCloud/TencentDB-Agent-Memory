/**
 * iWiki MCP 客户端（Streamable HTTP，JSON-RPC 2.0）。
 *
 * 封装三个 MCP 工具：列子级、取正文、取元数据。
 * 具体字段名/参数形态以 MCP 服务端契约为准，不在源码注释中固化
 * （避免随代码外泄上游实现细节；变更时以实测为准）。
 *
 * 认证：个人令牌（Bearer），由调用方通过 SourceContext 注入；
 * 端点地址来自部署配置 `WIKI_SOURCE_IWIKI_MCP_URL`，无内置默认值。
 *
 * 响应包络：{ result: { content: [{ type:"text", text:"..." }] } }；错误走 { error: { message } }
 */

import type { SourceContext } from "../../types.js";

export class IWikiMcpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IWikiMcpError";
  }
}

interface McpEnvelope {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

/**
 * 从 { result: { content: [{text}] } } 里取出 text；已是字符串则原样返回。
 *
 * 关键：MCP 有两层错误——
 *   1) HTTP 401/403、非 2xx、JSON-RPC 的 { error } —— 由 callTool 处理；
 *   2) **业务层失败**：JSON-RPC 成功（无 error）但 `result.isError === true`，
 *      此时 result.content 里装的是**错误文本**，不是文档正文。
 * 若不拦截第 2 层，错误文本会被下游 `filter(c => c.markdown)` 判为非空，
 * 从而把报错内容当作文档正文写进 wiki raw。故这里必须优先判 isError。
 */
function unwrap(result: unknown): unknown {
  if (result && typeof result === "object" && "content" in result) {
    const env = result as McpEnvelope;
    if (env.isError === true) {
      const detail =
        env.content
          ?.map((c) => (typeof c?.text === "string" ? c.text : ""))
          .join("\n")
          .trim() || "unknown MCP tool error";
      throw new IWikiMcpError(`iWiki MCP tool error: ${detail}`);
    }
    const text = env.content?.[0]?.text;
    if (typeof text === "string") {
      // 部分工具返回 JSON 字符串，部分直接返回 markdown/文本
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return result;
}

async function callTool(
  ctx: SourceContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const url = ctx.endpoint.replace(/\/+$/, "");

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ctx.secret}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: AbortSignal.timeout(ctx.timeoutMs ?? 15000),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const isNetwork = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR/i.test(detail);
    throw new IWikiMcpError(
      isNetwork
        // 注意：不要把端点地址放进错误信息 —— 它是内网地址，会随响应返回到前端。
        ? `无法连接 iWiki MCP 端点：${detail}。请确认 WIKI_SOURCE_IWIKI_MCP_URL 配置正确且网络可达。`
        : `iWiki MCP request failed (${toolName}): ${detail}`,
    );
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new IWikiMcpError("iWiki token invalid or expired（太湖个人令牌无效或已过期）", resp.status);
  }
  if (!resp.ok) {
    throw new IWikiMcpError(`iWiki MCP error (${toolName}): HTTP ${resp.status}`, resp.status);
  }

  let json: { error?: { message?: string }; result?: unknown };
  try {
    json = (await resp.json()) as { error?: { message?: string }; result?: unknown };
  } catch {
    throw new IWikiMcpError(`iWiki MCP non-JSON response (${toolName})`);
  }
  if (json.error) {
    throw new IWikiMcpError(`iWiki MCP error (${toolName}): ${json.error.message ?? "unknown"}`);
  }
  return unwrap(json.result);
}

/** 页面树节点（实测字段：docid / title / parentid / has_children）。 */
export interface IWikiTreeNode {
  docid: number;
  title: string;
  parentid?: number;
  has_children?: boolean;
}

function assertNodeArray(raw: unknown): IWikiTreeNode[] {
  if (Array.isArray(raw)) return raw as IWikiTreeNode[];
  // 错误包络：{ msg:"error", message:"..." }
  // 注意：不要把上游工具方法名写进错误信息 —— 它属内部实现细节，会随响应返回前端。
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (o.msg === "error" && typeof o.message === "string") {
      throw new IWikiMcpError(o.message);
    }
  }
  throw new IWikiMcpError("unexpected response: not a node array");
}

/**
 * 拉取**直接子级**文档列表（不是整棵树）。
 *
 * @param parentId 父文档 id，必须是 number
 */
export async function getSpacePageTree(
  ctx: SourceContext,
  parentId: number,
): Promise<IWikiTreeNode[]> {
  const raw = await callTool(ctx, "getSpacePageTree", { parentid: parentId });
  return assertNodeArray(raw);
}

/** 用 spaceKey 取空间根目录的直接子级。 */
export async function getSpaceRoot(
  ctx: SourceContext,
  spaceKey: string,
): Promise<IWikiTreeNode[]> {
  const raw = await callTool(ctx, "getSpacePageTree", { spaceKey });
  return assertNodeArray(raw);
}

/** 拉取单个文档（返回 markdown）。实测只认 docid（string）。 */
export async function getDocument(
  ctx: SourceContext,
  docId: string,
): Promise<{ markdown: string; title?: string }> {
  const raw = await callTool(ctx, "getDocument", { docid: docId });
  if (typeof raw === "string") return { markdown: raw };
  const obj = (raw ?? {}) as Record<string, unknown>;
  const markdown =
    (typeof obj.markdown === "string" && obj.markdown) ||
    (typeof obj.content === "string" && obj.content) ||
    (typeof obj.body === "string" && obj.body) ||
    (typeof obj.text === "string" && obj.text) ||
    "";
  return {
    markdown,
    title: typeof obj.title === "string" ? obj.title : undefined,
  };
}

/**
 * 文档元数据（标题/更新时间/内容类型），用于补全列表里的标题。
 *
 * `contentType` 实测取值："FOLDER"（目录）或普通文档类型。
 * /p/<docid> 链接可能是目录页，必须靠它才能判断是否要展开子级，
 * 否则目录会被当单文档处理，导致子文档全部丢失。
 */
export async function getMetadata(
  ctx: SourceContext,
  docId: string,
): Promise<{ title?: string; updatedAt?: string; contentType?: string }> {
  const raw = await callTool(ctx, "metadata", { docid: docId });
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    title: typeof obj.title === "string" ? obj.title : undefined,
    updatedAt: typeof obj.updatetime === "string" ? obj.updatetime : undefined,
    contentType: typeof obj.content_type === "string" ? obj.content_type : undefined,
  };
}
