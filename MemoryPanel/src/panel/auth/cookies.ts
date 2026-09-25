export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || undefined;
  }
  return undefined;
}

export function buildSessionCookie(
  ...args: [name: string, token: string, maxAgeSeconds: number, secure: boolean]
): string {
  const [name, token, maxAgeSeconds, secure] = args;
  const attributes = [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * 构建"会话级" Cookie（不写 Max-Age / Expires）。
 *
 * 与 buildSessionCookie 的区别：后者总带 Max-Age，浏览器关闭后依然保留（持久化）；
 * 会话级 Cookie 随浏览器会话结束自动消失。适合表达"本次浏览期间的临时选择"——
 * 这类选择不该跨越浏览器重启，否则用户会困在一个自己早已忘记的旧决定里。
 */
export function buildTransientCookie(name: string, value: string, secure: boolean): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function buildExpiredSessionCookie(name: string, secure: boolean): string {
  return buildSessionCookie(name, '', 0, secure);
}
