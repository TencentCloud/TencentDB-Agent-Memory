/**
 * 敏感信息脱敏工具 —— 所有「可能被回显的错误信息」出口的统一收口点。
 *
 * 背景：git 的错误信息会把 remote URL 原样回显，而历史版本允许
 * `https://user:token@host/repo.git` 这类内嵌凭证的写法。这些字符串一旦
 * 流到 API 响应 / 访问日志 / 审计 detail / TMC 回调 / 服务日志，就等于
 * 把凭证写进了多个持久化位置。
 *
 * 因此 URL 内嵌凭证现在被 `GitSourceFetcher.validate()` 直接拒绝（安全加固），
 * 本模块作为**第二道防线**兜住历史数据与第三方产出的字符串。
 *
 * 已知边界：这里只做「字符串层面的确定性替换」，不做语义解析。因此调用方
 * 若知道本次操作使用的明文凭证，应当通过 `secrets` 参数显式传入以获得
 * 精确替换。
 */

/** `//user:pass@` / `//user@` 形式的内嵌凭证。scp-like（git@host:path）不含 `//`，不会被误伤。 */
const USERINFO_RE = /(\/\/)[^/@\s]*@/g;

/** 默认截断长度，与 code-graph 的 sync_error 落库长度保持一致。 */
const DEFAULT_MAX_LENGTH = 500;

/** 把 `scheme://user:secret@host/...` 里的 userinfo 段替换为 `***`。 */
export function stripUserInfo(text: string): string {
  if (!text) return text;
  return text.replace(USERINFO_RE, "$1***@");
}

/**
 * 脱敏一条可能含凭证的错误信息。
 *
 * @param message 原始错误信息
 * @param secrets 本次操作已知的明文凭证（如 token / 私钥）。短于 4 字符的值
 *                会被忽略 —— 否则 `replaceAll` 会把正常文本打成筛子。
 * @param maxLength 截断长度；<= 0 表示不截断
 */
export function sanitizeGitError(
  message: string,
  secrets?: Iterable<string>,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string {
  let out = stripUserInfo(String(message ?? ""));

  if (secrets) {
    for (const secret of secrets) {
      if (typeof secret !== "string" || secret.length < 4) continue;
      out = out.split(secret).join("***");
    }
  }

  return maxLength > 0 && out.length > maxLength ? out.slice(0, maxLength) : out;
}
