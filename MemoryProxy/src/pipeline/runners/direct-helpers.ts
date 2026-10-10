/**
 * Direct passthrough pure helpers (Phase 4.1)。
 *
 * 提取自老 directHandler.ts (line 70-113); direct runner + 测试都从这里 import,
 * 保证 helper 无副作用可独立单测。
 */

/** 版本号段正则: v 后接一个或多个数字 (v1 / v10 ...)。 */
const VERSION_SEGMENT_RE = /^v\d+$/i;

/** 上游协议类型。仅这两种走观测; 其它端点纯透传。 */
export type DirectUpstreamProtocol = "anthropic" | "openai";

/**
 * 从 /direct/... 请求路径解析出 upstream 目标路径。
 * 先去 /direct 前缀, 再去紧跟的 vN 段; 剥离后为空则返回 ""。
 */
export function stripDirectPrefix(requestPath: string): string {
  const directMatch = requestPath.match(/^\/direct(\/.*)?$/);
  if (!directMatch) return requestPath;
  let rest = directMatch[1] ?? "";
  if (rest === "") return "";
  const firstSegMatch = rest.match(/^\/([^/]+)(\/.*)?$/);
  if (firstSegMatch && VERSION_SEGMENT_RE.test(firstSegMatch[1] ?? "")) {
    rest = firstSegMatch[2] ?? "";
  }
  return rest;
}

/** upstream URL 拼接: upstream.url + 剥离后的路径 + query string。 */
export function buildDirectUpstreamUrl(
  upstreamBase: string,
  requestPath: string,
  requestUrl: string,
): string {
  const stripped = stripDirectPrefix(requestPath);
  const normalizedBase = upstreamBase.replace(/\/+$/, "");
  const pathPart = stripped.startsWith("/") ? stripped : stripped ? `/${stripped}` : "";
  let query = "";
  const qIdx = requestUrl.indexOf("?");
  if (qIdx >= 0) query = requestUrl.slice(qIdx);
  return `${normalizedBase}${pathPart}${query}`;
}

/** 根据剥离后的路径判定上游协议。null = 不做观测 (纯透传)。 */
export function detectProtocol(strippedPath: string): DirectUpstreamProtocol | null {
  const p = strippedPath.replace(/\/+$/, "");
  if (p === "/messages") return "anthropic";
  if (p === "/chat/completions") return "openai";
  return null;
}
