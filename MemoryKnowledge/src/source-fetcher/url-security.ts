/**
 * Git URL 安全工具 — 规范化 + SSRF/DNS 解析校验（949spec §9 / §13 / §18）。
 *
 * §18 URL Canonicalization：
 *   - normalize scheme（https/ssh）；
 *   - normalize hostname casing（小写）；
 *   - remove userinfo（含凭据的 URL 必须被拒绝，见 §9 CREDENTIAL_IN_URL_NOT_ALLOWED）；
 *   - normalize default ports（443/22 省略）；
 *   - preserve repository path semantics；
 *   - reject control characters / newline injection / shell metacharacters。
 *
 * §13.1 Application-Level Validation（调用 git 之前）：
 *   1. parse URL → 2. canonicalize hostname+port → 3. reject unsupported schemes
 *   → 4. reject literal private/local IPs → 5. resolve A and AAAA → 6. reject if
 *   ANY resolved address is forbidden。
 *
 * 注意：仅应用层校验不够（DNS rebinding，§13.2），网络层 egress 策略由部署拓扑
 * （worker 容器/防火墙）强制执行；本模块是纵深防御的第一层。
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const GIT_URL_ERROR = {
  /** §9：URL 内嵌 userinfo（user:token@）→ 拒绝。 */
  CREDENTIAL_IN_URL_NOT_ALLOWED: "CREDENTIAL_IN_URL_NOT_ALLOWED",
  /** 不支持的协议（http 明文 / 其它）。 */
  UNSUPPORTED_PROTOCOL: "UNSUPPORTED_PROTOCOL",
  /** URL 含控制字符/换行注入。 */
  MALFORMED_URL: "MALFORMED_URL",
  /** 字面量指向内网/环回/metadata 地址。 */
  PRIVATE_ADDRESS_BLOCKED: "PRIVATE_ADDRESS_BLOCKED",
  /** DNS 解析出的任一地址落在禁止网段。 */
  DNS_RESOLUTION_BLOCKED: "DNS_RESOLUTION_BLOCKED",
  /** 域名无法解析。 */
  DNS_RESOLUTION_FAILED: "DNS_RESOLUTION_FAILED",
} as const;

export type GitUrlErrorCode = (typeof GIT_URL_ERROR)[keyof typeof GIT_URL_ERROR];

export class GitUrlError extends Error {
  readonly code: GitUrlErrorCode;
  constructor(code: GitUrlErrorCode, message: string) {
    super(message);
    this.name = "GitUrlError";
    this.code = code;
  }
}

/** 规范化后的仓库身份（§18 canonical repository identity，与凭据无关）。 */
export interface CanonicalRepo {
  /** 规范化协议：https | ssh */
  protocol: "https" | "ssh";
  /** 规范化干净 URL（无 userinfo、host 小写、默认端口省略）。 */
  url: string;
  host: string;
  port: number;
  /** 仓库路径（git@host:path 的 scp 风格已归一为 path）。 */
  path: string;
}

// ───────────────────────── 禁止网段判定 ─────────────────────────

/** 禁止的 IPv4 网段（§13.1）：loopback / RFC1918 / link-local / multicast / unspecified / 云元数据。 */
const FORBIDDEN_V4_PREFIXES: Array<{ prefix: number; bits: number; label: string }> = [
  { prefix: 0x00000000, bits: 8, label: "unspecified/0.0.0.0" },      // 0.0.0.0/8
  { prefix: 0x0a000000, bits: 8, label: "RFC1918 10.0.0.0/8" },        // 10.0.0.0/8
  { prefix: 0x7f000000, bits: 8, label: "loopback 127.0.0.0/8" },      // 127.0.0.0/8
  { prefix: 0xa9fe0000, bits: 16, label: "link-local 169.254.0.0/16" }, // 169.254.0.0/16（含云元数据 169.254.169.254）
  { prefix: 0xac100000, bits: 12, label: "RFC1918 172.16.0.0/12" },    // 172.16.0.0/12
  { prefix: 0xc0a80000, bits: 16, label: "RFC1918 192.168.0.0/16" },   // 192.168.0.0/16
  { prefix: 0xe0000000, bits: 4, label: "multicast 224.0.0.0/4" },     // 224.0.0.0/4
];

/** 禁止的 IPv6 网段（§13.1）：::/128、::1、fe80::/10（link-local）、fc00::/7（ULA）、ff00::/8（multicast）。
 *  注意 prefix 必须是对齐 128 位高位的完整值（如 fe80::/10 → fe8000... 共 32 位十六进制）。 */
const FORBIDDEN_V6_PREFIXES: Array<{ prefix: bigint; bits: number; label: string }> = [
  { prefix: 0x00000000000000000000000000000000n, bits: 128, label: "unspecified ::" },
  { prefix: 0x00000000000000000000000000000001n, bits: 128, label: "loopback ::1" },
  { prefix: 0xfe800000000000000000000000000000n, bits: 10, label: "IPv6 link-local fe80::/10" },
  { prefix: 0xfc000000000000000000000000000000n, bits: 7, label: "IPv6 ULA fc00::/7" },
  { prefix: 0xff000000000000000000000000000000n, bits: 8, label: "IPv6 multicast ff00::/8" },
];

function ipv4ToInt(addr: string): number {
  const parts = addr.split(".").map((p) => Number(p));
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv6ToBigInt(addr: string): bigint {
  // 展开 IPv6 为 16 字节大整数（处理 :: 压缩）。
  const [head, tail] = addr.includes("::") ? addr.split("::") : [addr, ""];
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const all = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  let value = 0n;
  for (const part of all) {
    value = (value << 16n) | BigInt(parseInt(part || "0", 16));
  }
  return value;
}

/** 判定 IP 是否属于禁止网段（§13.1 forbidden classes）。 */
export function isForbiddenAddress(ip: string): { blocked: boolean; label?: string } {
  const v4 = isIP(ip);
  if (v4 === 4) {
    const int = ipv4ToInt(ip);
    for (const { prefix, bits, label } of FORBIDDEN_V4_PREFIXES) {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((int & mask) === (prefix & mask)) return { blocked: true, label };
    }
    return { blocked: false };
  }
  if (v4 === 6) {
    const big = ipv6ToBigInt(ip);
    for (const { prefix, bits, label } of FORBIDDEN_V6_PREFIXES) {
      const mask = bits === 128 ? (1n << 128n) - 1n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
      if ((big & mask) === (prefix & mask)) return { blocked: true, label };
    }
    return { blocked: false };
  }
  // 非 IP 字面量（域名）不在此判断。
  return { blocked: false };
}

// ───────────────────────── URL 规范化 ─────────────────────────

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const SHELL_META_RE = /[;&|`$<>"'\\\n\r]/;

/**
 * 规范化仓库 URL（§18）。
 * - 支持 https://host/path 与 ssh://host/path、scp 风格 git@host:path；
 * - 拒绝 userinfo（§9：CREDENTIAL_IN_URL_NOT_ALLOWED）；
 * - 拒绝 http 明文（§3 Non-Goals：不支持 plaintext HTTP remotes）；
 * - 拒绝控制字符/换行/shell 元字符。
 */
export function canonicalizeGitUrl(raw: string): CanonicalRepo {
  if (typeof raw !== "string" || !raw) throw new GitUrlError(GIT_URL_ERROR.MALFORMED_URL, "repo url is required");
  if (raw.length > 2048) throw new GitUrlError(GIT_URL_ERROR.MALFORMED_URL, "repo url too long");
  if (CONTROL_CHAR_RE.test(raw) || SHELL_META_RE.test(raw)) {
    throw new GitUrlError(GIT_URL_ERROR.MALFORMED_URL, "repo url contains control/shell characters");
  }

  // scp 风格：git@host:org/repo.git → ssh://git@host/org/repo.git
  let input = raw.trim();
  if (/^[^/]+@[^:]+:/.test(input) && !input.includes("://")) {
    const at = input.indexOf("@");
    const colon = input.indexOf(":");
    const user = input.slice(0, at);
    const host = input.slice(at + 1, colon);
    const path = input.slice(colon + 1);
    if (!user || !host || !path) throw new GitUrlError(GIT_URL_ERROR.MALFORMED_URL, "invalid scp-style url");
    if (!/^[a-zA-Z0-9._-]+$/.test(host)) {
      throw new GitUrlError(GIT_URL_ERROR.MALFORMED_URL, "invalid host in scp-style url");
    }
    input = `ssh://${user}@${host}/${path}`;
  }

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new GitUrlError(GIT_URL_ERROR.MALFORMED_URL, "cannot parse repo url");
  }

  // §9：拒绝 URL 内嵌凭据。
  //   - https：userinfo（user:token@）一律拒绝；
  //   - ssh：允许用户名（git@host 是标准 SSH 连接信息），但拒绝 password（token/口令）。
  if (u.protocol === "https:" && (u.username || u.password)) {
    throw new GitUrlError(GIT_URL_ERROR.CREDENTIAL_IN_URL_NOT_ALLOWED, "credential in url is not allowed");
  }
  if (u.protocol === "ssh:" && u.password) {
    throw new GitUrlError(GIT_URL_ERROR.CREDENTIAL_IN_URL_NOT_ALLOWED, "credential in url is not allowed");
  }

  let protocol: "https" | "ssh";
  if (u.protocol === "https:") protocol = "https";
  else if (u.protocol === "ssh:") protocol = "ssh";
  else if (u.protocol === "http:") {
    throw new GitUrlError(GIT_URL_ERROR.UNSUPPORTED_PROTOCOL, "plaintext http remotes are not supported");
  } else {
    throw new GitUrlError(GIT_URL_ERROR.UNSUPPORTED_PROTOCOL, `unsupported protocol: ${u.protocol}`);
  }

  const host = u.hostname.toLowerCase();
  if (!host) throw new GitUrlError(GIT_URL_ERROR.MALFORMED_URL, "repo url has no host");

  // 规范化默认端口（https 443 / ssh 22 省略）。
  let port = u.port ? Number(u.port) : protocol === "https" ? 443 : 22;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new GitUrlError(GIT_URL_ERROR.MALFORMED_URL, "invalid port");
  }
  const portSuffix = port === (protocol === "https" ? 443 : 22) ? "" : `:${port}`;

  // 仓库路径（保留语义，拒绝空路径 / 路径穿越）。
  let path = u.pathname.replace(/^\/+/, "");
  if (!path) throw new GitUrlError(GIT_URL_ERROR.MALFORMED_URL, "repo url has no path");
  if (path.includes("..")) throw new GitUrlError(GIT_URL_ERROR.MALFORMED_URL, "repo path must not contain '..'");

  // ssh 保留用户名（git@host 是连接所需；https 无 userinfo 已在上方拒绝）。
  const userPrefix = protocol === "ssh" && u.username ? `${u.username}@` : "";
  const url = `${protocol}://${userPrefix}${host}${portSuffix}/${path}`;
  return { protocol, url, host, port, path };
}

// ───────────────────────── SSRF 校验 ─────────────────────────

export interface SsrfValidationOptions {
  /** 字面量 IP / DNS 解析结果是否拒绝禁止网段。默认 true。 */
  enabled?: boolean;
  /** 测试注入：跳过真实 DNS，返回给定地址（供 SSRF 测试套件用）。 */
  resolveOverride?: (hostname: string) => Promise<string[]>;
}

const HOSTNAME_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/**
 * 调用 git 前的 SSRF 应用层校验（§13.1）：
 *   1. 字面量 IP → 直接判禁止网段；
 *   2. 域名 → 解析 A + AAAA（全部地址）→ 任一 forbidden 即拒绝。
 * 抛 GitUrlError；安全通过返回解析出的地址（供日志脱敏统计）。
 */
export async function assertSafeRemote(repo: CanonicalRepo, opts?: SsrfValidationOptions): Promise<string[]> {
  if (opts?.enabled === false) return [];
  const host = repo.host;

  // 字面量 IP：跳过 DNS，直接判定。
  if (isIP(host)) {
    const { blocked, label } = isForbiddenAddress(host);
    if (blocked) {
      throw new GitUrlError(GIT_URL_ERROR.PRIVATE_ADDRESS_BLOCKED, `repo host ${host} is a forbidden address (${label})`);
    }
    return [host];
  }

  // 域名格式合法性（防 DNS 库解析异常输入）。
  if (!HOSTNAME_RE.test(host)) {
    throw new GitUrlError(GIT_URL_ERROR.MALFORMED_URL, `invalid hostname: ${host}`);
  }

  let addresses: string[];
  if (opts?.resolveOverride) {
    addresses = await opts.resolveOverride(host);
  } else {
    try {
      const result = await lookup(host, { all: true, verbatim: true });
      addresses = result.map((r) => r.address);
    } catch {
      throw new GitUrlError(GIT_URL_ERROR.DNS_RESOLUTION_FAILED, `cannot resolve host: ${host}`);
    }
  }

  if (addresses.length === 0) {
    throw new GitUrlError(GIT_URL_ERROR.DNS_RESOLUTION_FAILED, `host resolves to no address: ${host}`);
  }

  for (const addr of addresses) {
    const { blocked, label } = isForbiddenAddress(addr);
    if (blocked) {
      throw new GitUrlError(
        GIT_URL_ERROR.DNS_RESOLUTION_BLOCKED,
        `host ${host} resolves to forbidden address ${addr} (${label})`,
      );
    }
  }
  return addresses;
}
