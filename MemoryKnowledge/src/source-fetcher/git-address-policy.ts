import * as net from "node:net";
import * as dns from "node:dns/promises";

/**
 * Parses an IPv4 string into a 32-bit unsigned integer.
 * Rejects non-standard formats (e.g., octal, hex).
 */
export function parseIPv4(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return -1;
  let num = 0;
  for (const part of parts) {
    const val = parseInt(part, 10);
    // Strict validation: must be a number 0-255, and string must strictly match the base-10 string
    if (isNaN(val) || val < 0 || val > 255 || part !== val.toString()) {
      return -1;
    }
    num = (num << 8) | val;
  }
  return num >>> 0; // Return unsigned 32-bit integer
}

/**
 * Checks if an IPv4 address is in a non-public range.
 */
export function isNonPublicIPv4(ip: string): boolean {
  const num = parseIPv4(ip);
  if (num === -1) return true; // Invalid format treated as non-public

  // IANA IPv4 Special-Purpose Address Registry
  // JavaScript bitwise operators treat operands as 32-bit signed integers, so we must >>> 0 after masking.
  if (((num & 0xff000000) >>> 0) === 0x00000000) return true; // 0.0.0.0/8 (This host on this network)
  if (((num & 0xff000000) >>> 0) === 0x0a000000) return true; // 10.0.0.0/8 (Private-Use)
  if (((num & 0xffc00000) >>> 0) === 0x64400000) return true; // 100.64.0.0/10 (Shared Address Space / CGNAT)
  if (((num & 0xff000000) >>> 0) === 0x7f000000) return true; // 127.0.0.0/8 (Loopback)
  if (((num & 0xffff0000) >>> 0) === 0xa9fe0000) return true; // 169.254.0.0/16 (Link Local)
  if (((num & 0xfff00000) >>> 0) === 0xac100000) return true; // 172.16.0.0/12 (Private-Use)
  if (((num & 0xffffff00) >>> 0) === 0xc0000000) return true; // 192.0.0.0/24 (IETF Protocol Assignments)
  if (((num & 0xffffff00) >>> 0) === 0xc0000200) return true; // 192.0.2.0/24 (Documentation - TEST-NET-1)
  if (((num & 0xffffff00) >>> 0) === 0xc0586300) return true; // 192.88.99.0/24 (6to4 Relay Anycast - Deprecated)
  if (((num & 0xffff0000) >>> 0) === 0xc0a80000) return true; // 192.168.0.0/16 (Private-Use)
  if (((num & 0xfffe0000) >>> 0) === 0xc6120000) return true; // 198.18.0.0/15 (Benchmarking)
  if (((num & 0xffffff00) >>> 0) === 0xc6336400) return true; // 198.51.100.0/24 (Documentation - TEST-NET-2)
  if (((num & 0xffffff00) >>> 0) === 0xcb007100) return true; // 203.0.113.0/24 (Documentation - TEST-NET-3)
  if (((num & 0xf0000000) >>> 0) === 0xe0000000) return true; // 224.0.0.0/4 (Multicast)
  if (((num & 0xf0000000) >>> 0) === 0xf0000000) return true; // 240.0.0.0/4 (Reserved)
  if (num === 0xffffffff) return true; // 255.255.255.255/32 (Limited Broadcast)

  return false;
}

/**
 * Parses an IPv6 string into a 128-bit bigint.
 */
export function parseIPv6(ip: string): bigint | null {
  const cleanIp = ip.split("%")[0]; // Remove zone index
  if (!net.isIPv6(cleanIp)) return null;

  // Handle IPv4-mapped/compatible
  const v4mapped = cleanIp.match(/^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) {
    const v4num = parseIPv4(v4mapped[1]);
    if (v4num === -1) return null;
    return (0xffffn << 32n) | BigInt(v4num);
  }

  let hexParts: string[] = [];
  const split = cleanIp.split("::");
  if (split.length > 2) return null;

  if (split.length === 2) {
    const left = split[0] === "" ? [] : split[0].split(":");
    const right = split[1] === "" ? [] : split[1].split(":");

    let ipv4Words: string[] = [];
    if (right.length > 0 && right[right.length - 1].includes(".")) {
      const v4str = right.pop()!;
      const v4num = parseIPv4(v4str);
      if (v4num === -1) return null;
      ipv4Words = [((v4num >>> 16) & 0xffff).toString(16), (v4num & 0xffff).toString(16)];
    }

    const missing = 8 - (left.length + right.length + ipv4Words.length);
    hexParts = [...left, ...Array(missing).fill("0"), ...right, ...ipv4Words];
  } else {
    hexParts = cleanIp.split(":");
    if (hexParts.length > 0 && hexParts[hexParts.length - 1].includes(".")) {
      const v4str = hexParts.pop()!;
      const v4num = parseIPv4(v4str);
      if (v4num === -1) return null;
      hexParts.push(((v4num >>> 16) & 0xffff).toString(16));
      hexParts.push((v4num & 0xffff).toString(16));
    }
  }

  if (hexParts.length !== 8) return null;
  let result = 0n;
  for (const part of hexParts) {
    result = (result << 16n) | BigInt(parseInt(part || "0", 16));
  }
  return result;
}

/**
 * Checks if an IPv6 address is in a non-public range.
 * Uses a conservative policy: rejects addresses outside global-unicast 2000::/3,
 * and rejects special-use/transition subranges inside it.
 */
export function isNonPublicIPv6(ip: string): boolean {
  const num = parseIPv6(ip);
  if (num === null) return true;

  // Global Unicast is 2000::/3
  if ((num >> 125n) !== (parseIPv6("2000::")! >> 125n)) {
    return true; // Rejects loopback, unspecified, IPv4-mapped, ULA, Link-local, Multicast, etc.
  }

  // Inside 2000::/3, reject known special-purpose and transition ranges:
  if ((num >> 105n) === (parseIPv6("2001::")! >> 105n)) return true; // 2001::/23 (includes TEREDO, BMWG, ORCHIDv2)
  if ((num >> 96n) === (parseIPv6("2001:db8::")! >> 96n)) return true; // 2001:db8::/32 (Documentation)
  if ((num >> 112n) === (parseIPv6("2002::")! >> 112n)) return true; // 2002::/16 (6to4)
  if ((num >> 112n) === (parseIPv6("3ffe::")! >> 112n)) return true; // 3ffe::/16 (6bone)
  if ((num >> 112n) === (parseIPv6("3fff::")! >> 112n)) return true; // 3fff::/16 (Documentation space - rejecting whole /16 is a conservative choice)

  return false;
}

/**
 * Validates whether an IP address is a public address.
 */
export function isNonPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isNonPublicIPv4(ip);
  if (net.isIPv6(ip)) return isNonPublicIPv6(ip);
  return true; // Not a valid IP -> non-public
}

export interface ResolverOptions {
  ssrfCheck: boolean;
  dnsResolver?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

/**
 * Resolves the host to IPv4/IPv6 addresses and checks SSRF policy.
 * Collects both A and AAAA answers, rejects empty, invalid, or mixed results.
 * Returns validated literal addresses for transport pinning.
 */
export async function resolveAndValidate(host: string, options: ResolverOptions): Promise<string[]> {
  const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const isIP = net.isIP(cleanHost);
  if (isIP) {
    if (options.ssrfCheck && isNonPublicAddress(cleanHost)) {
      throw new Error(`SSRF Address Policy Violation: resolved to non-public IP`);
    }
    return [cleanHost];
  }

  let resolver = options.dnsResolver;
  if (!resolver) {
    resolver = async (hostname: string) => {
      const results: { address: string; family: number }[] = [];
      const errors: Error[] = [];

      try {
        const aRecords = await dns.resolve4(hostname);
        for (const ip of aRecords) results.push({ address: ip, family: 4 });
      } catch (err: any) {
        if (err.code !== "ENODATA" && err.code !== "ENOTFOUND") errors.push(err);
      }

      try {
        const aaaaRecords = await dns.resolve6(hostname);
        for (const ip of aaaaRecords) results.push({ address: ip, family: 6 });
      } catch (err: any) {
        if (err.code !== "ENODATA" && err.code !== "ENOTFOUND") errors.push(err);
      }

      if (errors.length > 0) {
        // Fail closed on a family error even when the other family returned public answers
        throw errors[0];
      }

      return results;
    };
  }

  const resolved = await resolver(host);
  if (!resolved || resolved.length === 0) {
    throw new Error(`DNS resolution failed or returned empty data`);
  }

  const validatedAddresses: string[] = [];
  let hasNonPublic = false;

  for (const { address } of resolved) {
    if (!net.isIP(address)) {
      throw new Error(`Invalid IP address returned by DNS`);
    }
    const nonPublic = isNonPublicAddress(address);
    if (nonPublic) {
      hasNonPublic = true;
    }
    validatedAddresses.push(address);
  }

  if (options.ssrfCheck) {
    if (hasNonPublic) {
      throw new Error(`SSRF Address Policy Violation: resolved to non-public IP`);
    }
  }

  return validatedAddresses;
}
