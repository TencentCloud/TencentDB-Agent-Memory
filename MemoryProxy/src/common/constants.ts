/**
 * 跨 handler/pipeline stage 复用的常量集合。
 *
 * 提取自 handler.ts / anthropicHandler.ts / codexHandler.ts / workbuddyHandler.ts /
 * directHandler.ts / auxiliaryHandler.ts 各自一份的 `SKIP_REQUEST_HEADERS` /
 * `SKIP_RESPONSE_HEADERS` (Phase 0.4, 2026-09-28)。
 *
 * ## 语义差异 (故意保留)
 *
 * 6 个 handler 里 SKIP_REQUEST_HEADERS 有两种版本:
 *   - `SKIP_REQUEST_HEADERS_HOP_BY_HOP` (4 项): handler/direct/aux 用, 只过
 *      RFC 7230 hop-by-hop 头
 *   - `SKIP_REQUEST_HEADERS_WITH_INTERNAL` (5 项): anthropic/codex/wb 用,
 *      在 hop-by-hop 基础上多加 `x-tdai-user-key` (proxy 内部身份头)
 *
 * ⚠️ **潜在 bug (待 Phase 4 迁移时统一修复)**:
 *    direct/aux 用 HOP_BY_HOP 版本, 意味着如果客户端 (unlikely 场景) 主动
 *    带 `x-tdai-user-key` header, direct/aux 会把它透传给上游, 泄漏 proxy
 *    内部身份到外部 API。Phase 4.1 direct/aux 切换进 pipeline 时统一改用
 *    WITH_INTERNAL 版本, 顺手修掉这个 latent leak。当前 Phase 0 保持 backward
 *    compat, 不改行为。
 *
 * ## 响应头 (完全一致)
 *
 * SKIP_RESPONSE_HEADERS 4 个 (content-length, content-encoding, transfer-encoding,
 * connection) 在 6 个 handler 里字段一致, 只有顺序略不同 —— 语义等价, 统一成
 * 一份即可。
 */

/**
 * 请求头黑名单 — hop-by-hop 版本 (4 项)。
 * 原用户: handler.ts / directHandler.ts / auxiliaryHandler.ts。
 */
export const SKIP_REQUEST_HEADERS_HOP_BY_HOP: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/**
 * 请求头黑名单 — hop-by-hop + proxy 内部身份头 (5 项)。
 * 原用户: anthropicHandler.ts / codexHandler.ts / workbuddyHandler.ts。
 * `x-tdai-user-key` 是 proxy 内部 session-init 才用的头, 绝不允许透传上游。
 */
export const SKIP_REQUEST_HEADERS_WITH_INTERNAL: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "x-tdai-user-key",
]);

/**
 * 响应头黑名单 (4 项, 6 个 handler 完全一致)。
 * 剥掉这些是因为 SSE + chunked encoding 场景下 content-length 会跟实际 body
 * 长度对不上, 客户端解析会报错。
 */
export const SKIP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

/**
 * 复制响应头, 剥掉 SKIP_RESPONSE_HEADERS 里的字段。
 * 提取自 direct/utility/codex/wb runner 各一份完全相同的实现 (Phase 4 stage 化)。
 */
export function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}
