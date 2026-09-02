/**
 * 错误提示：把 HTTP 状态码映射成一句话修复建议，方便用户直接照着做。
 */

export function hintForStatus(status: number): string {
  switch (status) {
    case 400:
      return "请求格式或参数有误，检查客户端配置与请求体";
    case 401:
      return "凭据无效或已过期，检查 API key 与上游配置";
    case 403:
      return "无权限访问，检查团队/角色授权";
    case 404:
      return "资源不存在，检查请求路径与配置";
    case 429:
      return "请求过于频繁，稍后重试或调低并发";
    case 502:
    case 503:
    case 504:
      return "上游服务暂不可用，检查 upstream 配置与网络";
    default:
      return "请查看代理日志定位具体原因";
  }
}

export interface FriendlyProxyError {
  code: string;
  message: string;
  hint: string;
}

/** 把抛出的异常包装成带提示的错误体。 */
export function friendlyProxyError(
  status: number,
  message: string,
): FriendlyProxyError {
  const code =
    status === 429
      ? "rate_limited"
      : status >= 500
        ? "upstream_error"
        : status === 401
          ? "unauthorized"
          : status === 403
            ? "forbidden"
            : "bad_request";
  return { code, message: message || "internal error", hint: hintForStatus(status) };
}
