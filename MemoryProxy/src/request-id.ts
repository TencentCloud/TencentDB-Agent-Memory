/**
 * 上下游 req-id 透传工具。
 *
 * 契约：
 * - 客户端/上游网关若带 `x-request-id` 头，我们必须把它作为本次请求的 trace 主键使用
 *   （ClickHouse request_id、Langfuse requestId、响应 body 的 requestId、
 *    响应头 x-request-id）。缺失才自己生成 uuidv7。
 * - 响应始终同时回发 `x-request-id`（跨系统标准）与历史 `x-contextturbo-request-id`
 *   （避免打破已有消费方；本仓老端点没有此 header，但保持既有风格一致）。
 * - body 层按现有协议 shape 之外加一个 `requestId` 顶层字段（OpenAI/Anthropic
 *   SDK 对未知字段都是忽略语义，零破坏）。
 *
 * 为什么只接 `x-request-id`：行业约定里 `x-request-id` 是最广覆盖的事实标准
 * （OpenAI/Anthropic/多数 API 网关都用它）；避免别名吞入脏值，一律按单一来源读。
 */

/** 允许作为 req-id 的字符：可打印 ASCII，长度 1-128。超出一律按未提供处理，避免被恶意塞入巨串写入日志/DB。 */
const VALID_REQUEST_ID = /^[\x20-\x7e]{1,128}$/;

/** 从任意 header 提供者（Hono Context、Headers、普通对象）读取客户端带来的 x-request-id。 */
export function readIncomingRequestId(headers: {
  get?: (name: string) => string | null | undefined;
  header?: (name: string) => string | undefined;
} | Record<string, string | undefined> | undefined | null): string | undefined {
  if (!headers) return undefined;
  let raw: string | null | undefined;
  try {
    if (typeof (headers as { header?: unknown }).header === "function") raw = (headers as { header: (name: string) => string | undefined }).header("x-request-id");
    else if (typeof (headers as { get?: unknown }).get === "function") raw = (headers as { get: (name: string) => string | null | undefined }).get("x-request-id");
    else raw = (headers as Record<string, string | undefined>)["x-request-id"] ?? (headers as Record<string, string | undefined>)["X-Request-Id"];
  } catch { return undefined; }
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return VALID_REQUEST_ID.test(trimmed) ? trimmed : undefined;
}

/**
 * 统一的响应 header 组装：标准 `x-request-id`。接 extras 便于 caller 合并 content-type、retry-after。
 * 本仓历史上没有 x-contextturbo-request-id，因此只打一个。
 */
export function requestIdHeaders(id: string, extras?: Record<string, string>): Record<string, string> {
  return { "x-request-id": id, ...extras };
}

/**
 * 给任意 JSON 错误/成功 body 顶层塞 `requestId` 字段。无副作用，返回新对象。
 * 兼容本仓既有的 `request_id`（snake_case）字段：如果 body 已经有 request_id 就同时填入；
 * 没有的话只加 requestId。老路由（session-force-archive 等）不会被此函数覆盖，
 * 它们自己已经设了 request_id。
 */
export function withRequestId<T extends Record<string, unknown>>(body: T, id: string): T & { requestId: string } {
  return { ...body, requestId: id };
}

/**
 * 从任何"可能是 pipeline-ids-shape 的东西"里**绝对安全地**读两个关联 id。
 * 给错误日志用，调用方不用 try/catch：
 * - source 为 null/undefined → 两个都空串
 * - 子字段缺失或非 string → 对应字段空串
 * - 属性读取意外抛（exotic getter / Proxy trap） → 整体兜到空串
 *
 * 观测性原则：拿不到 id 日志要照常打，不能把主链路搞挂。
 *
 * 支持两种 shape：
 *   - PipelineIds-shape: { traceId, upstreamRequestId }
 *   - PipelineContext-shape: { traceId, upstreamRequestId? } (同一个字段名)
 */
export function safeTraceIds(source?: {
  traceId?: string | null;
  upstreamRequestId?: string | null;
} | null | undefined): { traceId: string; upstreamRequestId: string } {
  try {
    if (!source) return { traceId: "", upstreamRequestId: "" };
    let traceId = "";
    try {
      const v = source.traceId;
      if (typeof v === "string") traceId = v;
    } catch { /* keep "" */ }
    let upstreamRequestId = "";
    try {
      const v = source.upstreamRequestId;
      if (typeof v === "string") upstreamRequestId = v;
    } catch { /* keep "" */ }
    return { traceId, upstreamRequestId };
  } catch {
    return { traceId: "", upstreamRequestId: "" };
  }
}
