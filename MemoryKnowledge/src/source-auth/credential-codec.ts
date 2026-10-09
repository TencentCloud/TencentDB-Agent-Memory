/**
 * 凭据 base64 编解码（存储用；非加密）。
 *
 * 令牌以 base64 存入 `cred_secret`，使用时在内存解码。
 * base64 不提供机密性：Node 的 base64 解码不抛异常，非法输入会产出乱码 ——
 * 故必须**先**做字符集 + 长度校验，否则损坏内容会被当有效令牌拿去 clone。
 *
 * 保密性由访问控制承担（SQLite 文件权限 + 接口不回吐 + 明文不进日志），
 * 不由本模块承担。详见设计文档 §4.1.3。
 */

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** UTF-8 → base64。空串返回空串（由调用方保证 secret 非空）。 */
export function encodeSecret(plain: string): string {
  return Buffer.from(plain, "utf8").toString("base64");
}

/** base64 → UTF-8。非法输入返回 null（不抛异常）。 */
export function decodeSecret(b64: string | null | undefined): string | null {
  if (!b64 || b64.length % 4 !== 0 || !B64_RE.test(b64)) return null;
  return Buffer.from(b64, "base64").toString("utf8");
}
