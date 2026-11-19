import { describe, expect, it } from "vitest";
import {
  normalizeIPv4,
  isPrivateIPv4,
  isPrivateHostLiteral,
  resolveAndCheckHost,
  type LookupFn,
  type LookupResult,
} from "./ssrf-guard.js";

const mockLookup = (map: Record<string, string[]>): LookupFn => async (host) => {
  const addrs = map[host];
  if (!addrs) throw new Error("NXDOMAIN");
  return addrs.map((address): LookupResult => ({ address, family: address.includes(":") ? 6 : 4 }));
};

describe("normalizeIPv4 — alternate IPv4 spellings", () => {
  it("decodes integer / hex / octal loopback", () => {
    expect(normalizeIPv4("2130706433")).toEqual([127, 0, 0, 1]);
    expect(normalizeIPv4("0x7f000001")).toEqual([127, 0, 0, 1]);
    expect(normalizeIPv4("0177.0.0.1")).toEqual([127, 0, 0, 1]);
  });

  it("decodes IPv4-mapped IPv6 in both dotted and hex forms", () => {
    expect(normalizeIPv4("::ffff:127.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(normalizeIPv4("::ffff:7f00:1")).toEqual([127, 0, 0, 1]);
  });

  it("rejects out-of-range and malformed values", () => {
    expect(normalizeIPv4("999999999999")).toBeNull();
    expect(normalizeIPv4("not-an-ip")).toBeNull();
    expect(normalizeIPv4("256.1.1.1")).toBeNull();
  });
});

describe("isPrivateIPv4 — range classification", () => {
  it("blocks RFC1918, loopback, link-local, CGNAT, reserved", () => {
    expect(isPrivateIPv4([10, 0, 0, 1])).toBe(true);
    expect(isPrivateIPv4([172, 16, 0, 1])).toBe(true);
    expect(isPrivateIPv4([192, 168, 1, 1])).toBe(true);
    expect(isPrivateIPv4([127, 0, 0, 1])).toBe(true);
    expect(isPrivateIPv4([169, 254, 169, 254])).toBe(true);
    expect(isPrivateIPv4([100, 64, 0, 1])).toBe(true);
    expect(isPrivateIPv4([224, 0, 0, 1])).toBe(true);
  });

  it("allows public addresses and the public half of 172/16", () => {
    expect(isPrivateIPv4([8, 8, 8, 8])).toBe(false);
    expect(isPrivateIPv4([172, 32, 0, 1])).toBe(false);
    expect(isPrivateIPv4([140, 82, 114, 4])).toBe(false);
  });
});

describe("isPrivateHostLiteral — regex bypasses now blocked", () => {
  it("blocks the classic bypass spellings", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "2130706433",
      "0x7f000001",
      "0177.0.0.1",
      "::ffff:127.0.0.1",
      "::1",
      "[::1]",
    ]) {
      expect(isPrivateHostLiteral(host), host).toBe(true);
    }
  });

  it("does not block public hosts or IPs", () => {
    expect(isPrivateHostLiteral("github.com")).toBe(false);
    expect(isPrivateHostLiteral("8.8.8.8")).toBe(false);
  });
});

describe("resolveAndCheckHost — DNS-based protection", () => {
  it("blocks a hostname resolving to a private address", async () => {
    const r = await resolveAndCheckHost("internal.example.com", mockLookup({ "internal.example.com": ["10.0.0.5"] }));
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("private");
  });

  it("allows a hostname resolving to a public address", async () => {
    const r = await resolveAndCheckHost("good.example.com", mockLookup({ "good.example.com": ["140.82.114.4"] }));
    expect(r.blocked).toBe(false);
  });

  it("blocks when ANY resolved address is private", async () => {
    const r = await resolveAndCheckHost("multi.example.com", mockLookup({ "multi.example.com": ["140.82.114.4", "192.168.1.1"] }));
    expect(r.blocked).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 returned from DNS", async () => {
    const r = await resolveAndCheckHost("mapped.example.com", mockLookup({ "mapped.example.com": ["::ffff:127.0.0.1"] }));
    expect(r.blocked).toBe(true);
  });

  it("fails closed on resolution failure / empty result", async () => {
    expect((await resolveAndCheckHost("nx.example.com", mockLookup({}))).blocked).toBe(true);
    expect((await resolveAndCheckHost("empty.example.com", mockLookup({ "empty.example.com": [] }))).blocked).toBe(true);
  });

  it("classifies numeric literals without DNS", async () => {
    // Lookup fn throws on any call — proving no DNS was needed for the literal.
    const never = mockLookup({});
    expect((await resolveAndCheckHost("2130706433", never)).blocked).toBe(true);
    expect((await resolveAndCheckHost("8.8.8.8", never)).blocked).toBe(false);
  });
});
