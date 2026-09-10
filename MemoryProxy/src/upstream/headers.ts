/**
 * 上游转发相关的请求/响应头处理（4 个 handler 共用，去重后唯一实现）。
 */
import type { Context } from "hono";

/** 转发上游时跳过的请求头：传输层头与内部身份头不留给上游。 */
export const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "x-tdai-user-key",
]);

/** 回给客户端时跳过的响应头：传输层头不留给客户端。 */
export const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);

/** 把客户端请求头里非跳过的部分拷贝出来（不做鉴权改写，鉴权由调用方按协议处理）。 */
export function collectRequestHeaders(c: Context): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  return headers;
}

/** 过滤响应头，去掉传输层头。 */
export function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}
