/**
 * SSRF guard helpers — robust private/loopback address detection.
 *
 * The original check was a single regex over the raw host string. That misses
 * several standard ways to spell the same address, and does not resolve domain
 * names at all (so `internal.example.com -> 10.0.0.5` sails through). This module
 * centralises:
 *
 *   1. Normalisation of numeric / hex / octal IPv4 forms and IPv4-mapped IPv6.
 *   2. Bitwise classification of the resulting IPv4 / IPv6 address.
 *   3. An optional DNS-resolution step, so a hostname that resolves to a
 *      private address is rejected too (basic DNS-rebinding mitigation at
 *      validation time).
 *
 * Everything here is a pure function except `resolveAndCheckHost`, which takes
 * a `lookup` function as a parameter so it is fully testable without network.
 */

import { promises as dns } from "node:dns";

/** IPv4 address as four octets. */
type IPv4 = readonly [number, number, number, number];

/**
 * Expand the many textual spellings of an IPv4 address into dotted-decimal.
 *
 * Accepts:
 *   - dotted decimal          `127.0.0.1`
 *   - single integer          `2130706433` (== 127.0.0.1)
 *   - hex                     `0x7f000001`
 *   - octal-leading integers  `0177.0.0.1`
 *   - IPv4-mapped IPv6        `::ffff:127.0.0.1` and `::ffff:7f00:1`
 *
 * Returns `null` when the input is not an IPv4 literal in any known form.
 */
export function normalizeIPv4(input: string): IPv4 | null {
  let s = input.trim().toLowerCase();

  // IPv4-mapped IPv6: ::ffff:a.b.c.d or ::ffff:xxxx:xxxx
  const mapped = /^::ffff:(.+)$/.exec(s);
  if (mapped) s = mapped[1]!;

  // Pure integer / hex forms (no dots and no colons) -> 32-bit value
  if (!s.includes(".") && !s.includes(":")) {
    let value: number;
    if (/^0x[0-9a-f]+$/.test(s)) value = Number.parseInt(s.slice(2), 16);
    else if (/^[0-9]+$/.test(s)) value = Number.parseInt(s, 10);
    else return null;
    if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) return null;
    return [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
  }

  // IPv4-mapped IPv6 hex pair form ::ffff:7f00:1
  if (s.includes(":")) {
    const parts = s.split(":");
    const tail = parts.slice(-2);
    if (tail.length === 2 && /^[0-9a-f]{1,4}$/.test(tail[0]!) && /^[0-9a-f]{1,4}$/.test(tail[1]!)) {
      const hi = Number.parseInt(tail[0]!, 16);
      const lo = Number.parseInt(tail[1]!, 16);
      const value = (hi << 16) | lo;
      return [
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
      ];
    }
    return null;
  }

  // Dotted form, each octet may be decimal / 0x hex / leading-zero octal.
  const chunks = s.split(".");
  if (chunks.length !== 4) return null;
  const octets: number[] = [];
  for (const c of chunks) {
    let v: number;
    if (/^0x[0-9a-f]+$/.test(c)) v = Number.parseInt(c.slice(2), 16);
    else if (/^0[0-7]+$/.test(c)) v = Number.parseInt(c, 8);
    else if (/^[0-9]+$/.test(c)) v = Number.parseInt(c, 10);
    else return null;
    if (!Number.isFinite(v) || v < 0 || v > 255) return null;
    octets.push(v);
  }
  return octets as IPv4;
}

/** Is this IPv4 address private / loopback / link-local / reserved? */
export function isPrivateIPv4([a, b]: IPv4): boolean {
  // 0.0.0.0/8 — "this network"
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 100.64.0.0/10 — carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (incl. 169.254.169.254 cloud metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 — benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved (>=224)
  if (a >= 224) return true;
  return false;
}

/**
 * Detect private/loopback IPv6 addresses. Covers the common risky ranges;
 * deliberately conservative — unknown/unique-local forms are treated as
 * private so a novel spelling cannot slip through.
 */
export function isPrivateIPv6(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1" || /^::1$/.test(h)) return true;          // loopback
  if (/^f[cd]/.test(h)) return true;                        // unique local fc00::/7
  if (/^fe[89ab]/.test(h)) return true;                     // link-local fe80::/10
  if (/^::ffff:/.test(h)) {                                 // IPv4-mapped — handled by caller
    const v4 = normalizeIPv4(h);
    return v4 ? isPrivateIPv4(v4) : true;                    // unparseable mapped -> deny
  }
  if (h === "::") return true;                                // unspecified address
  return false;
}

/**
 * Classify a host literal (no DNS) as private/loopback.
 * Hostnames that are not IP literals return `false` here and must be checked
 * via `resolveAndCheckHost`.
 */
export function isPrivateHostLiteral(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "ip6-localhost" || h === "ip6-loopback") return true;

  // If it looks like an IPv4 literal in any form, classify the parsed value.
  const v4 = normalizeIPv4(h);
  if (v4) return isPrivateIPv4(v4);

  // Numeric-only / hex strings that failed IPv4 parsing should be denied
  // rather than treated as a harmless hostname.
  if (/^(0x[0-9a-f]+|[0-9]+|::)/i.test(h)) return true;

  if (h.includes(":")) return isPrivateIPv6(h); // raw IPv6 literal
  return false;
}

export interface LookupResult {
  address: string;
  family: number;
}

export type LookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<readonly LookupResult[]>;

/**
 * Resolve a hostname and reject it if ANY resolved address is private.
 * Uses `dns.lookup(..., { all: true })` so all A/AAAA records are inspected.
 * If resolution fails (NXDOMAIN / timeout), we deny — a repo URL that cannot
 * resolve is not going to clone anyway, and failing closed avoids a bypass
 * where an attacker points at a host that only resolves selectively.
 */
export async function resolveAndCheckHost(
  host: string,
  lookup: LookupFn = (h, o) => dns.lookup(h, o),
): Promise<{ blocked: boolean; reason?: string }> {
  // Literal IPs need no DNS.
  if (normalizeIPv4(host) || host.includes(":")) {
    return isPrivateHostLiteral(host)
      ? { blocked: true, reason: "private/loopback literal" }
      : { blocked: false };
  }

  let addresses: readonly LookupResult[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return { blocked: true, reason: "DNS resolution failed" };
  }
  if (!addresses || addresses.length === 0) {
    return { blocked: true, reason: "DNS returned no addresses" };
  }
  for (const { address, family } of addresses) {
    const privateAddr =
      family === 6 || address.includes(":")
        ? isPrivateIPv6(address) || (normalizeIPv4(address) !== null && isPrivateIPv4(normalizeIPv4(address)!))
        : (() => { const v4 = normalizeIPv4(address); return v4 ? isPrivateIPv4(v4) : true; })();
    if (privateAddr) {
      return { blocked: true, reason: `resolves to private address ${address}` };
    }
  }
  return { blocked: false };
}
