/**
 * TAPD MCP JSON-RPC 客户端。
 *
 * 实测要点（2026-09-15，均已在真实网关验证）：
 *   1. 必须带 `Accept: application/json, text/event-stream`，缺失 → HTTP 406。
 *   2. 业务工具需两步：lookup_tool_param_schema → proxy_execute_tool。
 *      （lookup_tapd_tool 是语义发现工具，仅开发期使用，运行时跳过以省一次往返。）
 *   3. proxy_execute_tool 的 tool_args 是**对象**，不是字符串。
 *   4. 响应需二次解析：result.content[0].text 可能仍是 JSON 字符串。
 *   5. `page` 必须传 number（传字符串服务端报 `str - int`）；`limit` 两者皆可。
 *   6. workspace_id / id 必须传 string（19 位 id 超出 JS 安全整数范围）。
 */

import { TaskSourceError } from "../../types.js";

export interface TapdCallOptions {
  /** MCP 端点，由 registry 从部署配置注入。 */
  endpoint: string;
  /** Bearer access_token 或 PAT。 */
  token: string;
  /** 自定义 header 名；设置后令牌走该 header，否则走 Authorization。 */
  tokenHeader?: string;
  timeoutMs?: number;
}

interface JsonRpcResponse {
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  error?: { code?: number; message?: string };
}

export class TapdMcpClient {
  constructor(private readonly opts: TapdCallOptions) {}

  /**
   * 调用业务工具并取出已解析的数据（自动剥掉 `{limit,offset,count,page,data}` 包络）。
   */
  async call(toolName: string, toolArgs: Record<string, unknown>): Promise<unknown> {
    const raw = await this.callRaw(toolName, toolArgs);
    return unwrap(raw);
  }

  /** 调用业务工具，返回原始解析结果（保留分页包络）。 */
  async callRaw(toolName: string, toolArgs: Record<string, unknown>): Promise<unknown> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: "proxy_execute_tool", arguments: { tool_name: toolName, tool_args: toolArgs } },
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // 实测：缺失该头网关返回 406。
      Accept: "application/json, text/event-stream",
    };
    if (this.opts.tokenHeader) headers[this.opts.tokenHeader] = this.opts.token;
    else headers.Authorization = `Bearer ${this.opts.token}`;

    const res = await fetchWithTimeout(this.opts.endpoint, {
      method: "POST",
      headers,
      body,
      timeoutMs: this.opts.timeoutMs ?? 30_000,
    });

    if (res.status === 401 || res.status === 403) {
      throw new TaskSourceError("task_source_unauthorized", "credential rejected by TAPD");
    }
    if (!res.ok) {
      throw new TaskSourceError("task_source_upstream_error", `TAPD returned HTTP ${res.status}`);
    }

    const json = (await res.json()) as JsonRpcResponse;
    if (json.error) {
      throw new TaskSourceError(
        "task_source_upstream_error",
        json.error.message ?? "TAPD MCP error",
      );
    }
    /**
     * **业务层失败**：JSON-RPC 成功（无 error）、HTTP 也是 200，但
     * `result.isError === true` —— 此时 content[0].text 装的是**错误文本**，
     * 不是业务数据。
     *
     * 必须优先于 looksLikeUpstreamError 判断：后者靠文本特征匹配，
     * 遇到没预料到的错误措辞会漏；isError 是协议标志，可靠得多。
     * 若不拦截，错误文本会被当成 task 描述导入看板。
     */
    if (json.result?.isError === true) {
      const detail =
        json.result.content
          ?.map((c) => (typeof c?.text === "string" ? c.text : ""))
          .join("\n")
          .trim() || "unknown TAPD MCP tool error";
      throw new TaskSourceError("task_source_upstream_error", detail.slice(0, 200));
    }

    const text = json.result?.content?.[0]?.text ?? "";
    // 服务端参数校验失败时返回中文错误文本（如「参数X不存在于工具Y的参数定义中」），
    // 而非 JSON 包络。若静默当成「0 条结果」，会把配置错误伪装成空列表，极难排查。
    if (looksLikeUpstreamError(text)) {
      throw new TaskSourceError("task_source_upstream_error", text.trim().slice(0, 200));
    }
    // 二次解析：text 可能仍是 JSON 字符串；解析失败则按纯文本返回。
    return parseMaybeJson(text);
  }
}

/** 剥掉 TAPD 的统一分页包络，返回 data 数组。 */
export function unwrap(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const env = raw as { data?: unknown };
    if (Array.isArray(env.data)) return env.data;
  }
  return raw;
}

/** 取分页总数；无包络时回落到数组长度。 */
export function totalOf(raw: unknown, fallback: number): number {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const count = (raw as { count?: unknown }).count;
    if (typeof count === "number") return count;
    if (typeof count === "string" && /^\d+$/.test(count)) return Number(count);
  }
  return fallback;
}

/**
 * 识别服务端返回的错误文本（非 JSON、非数据）。
 *
 * 实测：参数不合法时网关返回形如
 *   「参数with_v_status不存在于工具bugs_get的参数定义中,请检查后重试」
 * 这类文本 HTTP 状态仍是 200，必须靠内容特征识别。
 */
function looksLikeUpstreamError(text: string): boolean {
  const t = text.trim();
  if (!t || t.startsWith("{") || t.startsWith("[")) return false;
  // 中文：参数校验失败
  if (/参数.*不存在|不存在于工具|请检查后重试|Traceback/.test(t)) return true;
  // 认证失败：MCP 网关端点返回「缺少 TAPD 认证信息 / AUTH_MISSING」，
  // 太湖身份解析失败则返回「decode taihu identity fail」。
  // 这类错误若不当场抛出，会被 asRows 当成「非数组」而静默返回空列表，
  // 让用户误以为「账号没有项目权限」。
  if (/缺少\s*TAPD\s*认证信息|AUTH_MISSING|缺少认证|unauthorized|decode .*identity fail/i.test(t)) {
    return true;
  }
  return false;
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TaskSourceError("task_source_timeout", "TAPD request timed out");
    }
    throw new TaskSourceError(
      "task_source_upstream_error",
      err instanceof Error ? err.message : "network error",
    );
  } finally {
    clearTimeout(timer);
  }
}
