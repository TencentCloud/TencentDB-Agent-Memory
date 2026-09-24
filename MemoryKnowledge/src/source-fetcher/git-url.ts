/**
 * git URL 解析 / 归一化 —— 协议白名单、host 校验、私有地址判定的唯一事实来源。
 *
 * 为什么不用 `new URL()` 一把梭：
 *   1. scp-like 形式 `git@host:path` 不是合法 URL（`new URL()` 抛 ERR_INVALID_URL），
 *      而它是 SSH 接入的事实标准写法；
 *   2. `new URL("https://[::1]/x").hostname` 返回**带方括号**的 `[::1]`，直接拿去
 *      和私有网段正则比对会漏判（历史实现就是这么漏掉 IPv6 回环的）；
 *   3. host 会被拼进 `GIT_SSH_COMMAND`、known_hosts 路径等由 shell 解释的字符串，
 *      必须在解析阶段就用字符白名单卡死，而不是等到拼接时再转义。
 *
 * 因此：http(s)/ssh 走 `new URL()`，scp-like 走独立正则，两者最终都收敛到
 * `normalizeHost()` + `isValidHost()`。
 */

export type GitProtocol = "https" | "http" | "ssh" | "scp";

export interface ParsedGitUrl {
  protocol: GitProtocol;
  /** 归一化后的 host（小写、无尾点、IPv6 无方括号）。可直接用于比对与落库。 */
  host: string;
  /** 原始 host 串（仅用于诊断信息）。 */
  rawHost: string;
  port?: number;
  path: string;
  /** URL / scp-like 里声明的用户名（`git@`、`oauth2@` 等），不是密钥。 */
  user?: string;
}

/** 带 scheme 的绝对 URL。 */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * scp-like：`[user@]host:path`。
 * 前置负向断言排除任何带 `scheme://` 的串，避免把 `ssh://`、`file://`、
 * 带端口的 `https://` 误判成 scp-like。
 */
const SCP_LIKE_RE = /^(?![A-Za-z][A-Za-z0-9+.-]*:\/\/)([^@/\s]+)@([^:/\s]+):(.+)$/;

/**
 * host 字符白名单（安全的 DNS 名 / IPv4 字面量）。
 * 刻意排除 `;` `$` 反引号 空格 引号 等 shell 元字符 —— 这是命令注入的第一道防线。
 * 允许 `_`（内网主机名常见），要求首尾字符非 `-`。
 */
const DNS_HOST_RE = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9._-]*[a-z0-9_])?$/;

/** IPv6 字面量（已去方括号后的形态）。 */
const IPV6_HOST_RE = /^[0-9a-f:]{2,}$/;

/**
 * 归一化 host：小写 → 去 IPv6 方括号 → 去 zone id → 去尾部点。
 * 目的是让 `Corp.Example.COM.`、`[::1]`、`fe80::1%en0` 这些等价写法收敛到同一形态，
 * 避免「黑名单拦不住、白名单匹配不上」的绕过。
 */
export function normalizeHost(host: string): string {
  let h = String(host ?? "").trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** host 是否通过字符白名单（DNS 名或 IPv6 字面量）。 */
export function isValidHost(host: string): boolean {
  if (!host) return false;
  if (host.includes(":")) return IPV6_HOST_RE.test(host);
  return DNS_HOST_RE.test(host);
}

/**
 * 解析 git URL。无法解析或 host 非法时返回 null（调用方应转成 400）。
 * 仅接受 http / https / ssh / scp-like 四种形态；其余（file / ftp / git）返回 null。
 */
export function parseGitUrl(raw: string): ParsedGitUrl | null {
  const url = String(raw ?? "").trim();
  if (!url || /\s/.test(url)) return null;

  if (SCHEME_RE.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }

    const protocol = schemeToProtocol(parsed.protocol);
    if (!protocol) return null;

    const host = normalizeHost(parsed.hostname);
    if (!isValidHost(host)) return null;

    const port = parsed.port ? Number(parsed.port) : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;

    return {
      protocol,
      host,
      rawHost: parsed.hostname,
      port,
      path: parsed.pathname,
      user: parsed.username || undefined,
    };
  }

  const m = SCP_LIKE_RE.exec(url);
  if (!m) return null;

  const host = normalizeHost(m[2]);
  if (!isValidHost(host)) return null;

  return { protocol: "scp", host, rawHost: m[2], path: m[3], user: m[1] };
}

function schemeToProtocol(scheme: string): GitProtocol | null {
  switch (scheme) {
    case "https:":
      return "https";
    case "http:":
      return "http";
    case "ssh:":
      return "ssh";
    default:
      return null;
  }
}

/**
 * URL 里是否内嵌了凭证。
 *   - http(s)：`https://user@host` 与 `https://user:pass@host` 都算（token 常被塞进 username 位）
 *   - ssh：`ssh://git@host` 的 user 是正常的；只有带 password 才算内嵌凭证
 *   - scp-like：`git@host:path` 的 user 是协议语法的一部分，不算凭证
 */
export function hasEmbeddedCredentials(raw: string): boolean {
  const url = String(raw ?? "").trim();
  if (!SCHEME_RE.test(url)) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return parsed.username !== "" || parsed.password !== "";
  }
  if (parsed.protocol === "ssh:") {
    return parsed.password !== "";
  }
  return false;
}

// ───────────────────────── 私有 / 内网地址判定 ─────────────────────────

/** IPv4 字面量是否落在私有 / 环回 / link-local 网段。 */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;

  const [a, b, c, d] = m.slice(1).map((p) => Number(p));
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;

  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10/8, 127/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // 169.254/16（含云元数据 169.254.169.254）
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  return false;
}

/** 把 `::ffff:` 之后的十六进制 IPv4 映射还原成点分十进制；无法还原时返回 null。 */
function unmapIpv4(hexPart: string): string | null {
  if (isPrivateIpv4(hexPart)) return hexPart; // 罕见的点分写法 ::ffff:127.0.0.1

  const groups = hexPart.split(":").filter(Boolean);
  if (groups.length !== 2) return null;
  const [g1, g2] = groups.map((g) => parseInt(g, 16));
  if (Number.isNaN(g1) || Number.isNaN(g2)) return null;

  return [g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff].join(".");
}

/**
 * 私有 / 环回 / link-local 判定。入参须先经 `normalizeHost()`。
 *
 * 与历史实现的关键差异：IPv6 在归一化后不再带方括号，且补齐了
 *   - `::` / `::1`
 *   - `fe80::/10`（含 fe8x/fe9x/feax/febx）
 *   - `fc00::/7`（含 fcx/fdx）
 *   - `::ffff:` IPv4 映射（含 `new URL` 规范化出的十六进制形态 `::ffff:7f00:1`）
 */
export function isPrivateHost(host: string): boolean {
  const h = normalizeHost(host);
  if (!h) return false;

  if (h === "localhost" || h.endsWith(".localhost")) return true;

  if (!h.includes(":")) return isPrivateIpv4(h);

  if (h === "::" || h === "::1") return true;
  if (/^(0{1,4}:){7}0{0,3}1$/.test(h)) return true; // 全展开的 ::1
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(h)) return true; // fc00::/7 unique local

  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) {
    const v4 = unmapIpv4(mapped[1]);
    return v4 ? isPrivateIpv4(v4) : true; // 映射串解析不了时按私有处理（fail-closed）
  }

  return false;
}

// ───────────────────────── host 白名单匹配 ─────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 单个白名单条目是否命中 host。入参均先经 `normalizeHost()`。
 *
 * 只支持两种写法，且**必须锚定匹配**：
 *   - `git.corp.example.com`  → 精确相等
 *   - `*.corp.example.com`    → 单层 label 通配（`^[a-z0-9_-]+\.corp\.example\.com$`）
 *
 * 通配写成单层 label 是刻意的：若用 `endsWith` / `includes`，`evilcorp.example.com`
 * 与 `x.corp.example.com.attacker.com` 都会绕过。
 * 端口不参与匹配（白名单只写 host）。
 */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
  const p = normalizeHost(pattern);
  if (!h || !p) return false;

  if (p.startsWith("*.") && !p.slice(2).includes("*")) {
    const suffix = p.slice(2);
    if (!suffix) return false;
    return new RegExp(`^[a-z0-9_-]+\\.${escapeRegExp(suffix)}$`).test(h);
  }

  if (p.includes("*")) return false; // 不支持的通配写法 → 不命中（fail-closed）
  return h === p;
}

/** host 是否命中白名单中的任意条目。 */
export function isAllowedHost(host: string, allowedHosts: readonly string[] = []): boolean {
  return allowedHosts.some((pattern) => hostMatchesPattern(host, pattern));
}

/**
 * 解析 KNOWLEDGE_GIT_ALLOWED_HOSTS —— 逗号分隔，条目为精确 host 或 `*.suffix`。
 * 放在这里（而非 git-fetcher）是为了让 config.ts 能在不引入 simple-git 的前提下复用。
 */
export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
