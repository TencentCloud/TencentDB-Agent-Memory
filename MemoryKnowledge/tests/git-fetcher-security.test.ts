import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitSourceFetcher } from "../src/source-fetcher/git-fetcher.js";
import { isNonPublicAddress, resolveAndValidate } from "../src/source-fetcher/git-address-policy.js";
import * as dns from "node:dns/promises";

vi.mock("node:dns/promises", () => {
  return {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  };
});

describe("git-address-policy", () => {
  describe("rejects loopback and private IPv4", () => {
    it.each([
      "127.0.0.1",
      "10.0.0.1",
      "172.16.1.1",
      "192.168.1.1"
    ])("rejects %s", (ip) => {
      expect(isNonPublicAddress(ip)).toBe(true);
    });
  });

  describe("rejects special-purpose IPv4", () => {
    it.each([
      "224.0.0.1",
      "240.0.0.1",
      "169.254.169.254",
      "100.64.0.1", // CGNAT
      "192.0.2.1", // TEST-NET-1
      "198.51.100.1", // TEST-NET-2
      "203.0.113.1", // TEST-NET-3
      "198.18.0.1", // Benchmarking
      "192.88.99.1", // 6to4 Anycast (deprecated)
      "0.0.0.0",
      "255.255.255.255"
    ])("rejects %s", (ip) => {
      expect(isNonPublicAddress(ip)).toBe(true);
    });
  });

  describe("rejects loopback and private IPv6", () => {
    it.each([
      "::1",
      "fc00::1", // ULA
      "fd00::1", // ULA
      "fe80::1", // Link-local
      "fe90::1", // Link-local
      "0:0:0:0:0:0:0:1" // Expanded loopback
    ])("rejects %s", (ip) => {
      expect(isNonPublicAddress(ip)).toBe(true);
    });
  });

  describe("rejects special-purpose IPv6", () => {
    it.each([
      "::ffff:127.0.0.1", // IPv4-mapped private
      "::ffff:8.8.8.8", // IPv4-mapped public
      "::ffff:7f00:1", // IPv4-mapped loopback in hex
      "2001:db8::1", // Documentation
      "2001:20::1", // ORCHIDv2
      "64:ff9b::a00:1", // WKP IPv4/IPv6 translation
      "3fff::1", // 6bone
      "::" // Unspecified
    ])("rejects %s", (ip) => {
      expect(isNonPublicAddress(ip)).toBe(true);
    });
  });

  describe("allows public IPv4 and IPv6", () => {
    it.each([
      "8.8.8.8",
      "1.1.1.1",
      "2606:4700:4700::1111", // Cloudflare public
      "2001:4860::8888" // Google public DNS IPv6
    ])("allows %s", (ip) => {
      expect(isNonPublicAddress(ip)).toBe(false);
    });
  });

  describe("rejects invalid octets or formats", () => {
    it.each([
      "0177.0.0.1", // Octal format
      "0x7f.0.0.1", // Hex format
      "2130706433", // Integer format
      "127.1" // Short format
    ])("rejects %s", (ip) => {
      expect(isNonPublicAddress(ip)).toBe(true);
    });
  });
});

describe("GitSourceFetcher security validation", () => {
  const fetcher = new GitSourceFetcher({ ssrfCheck: true });

  it("validates basic https URLs", () => {
    expect(() => fetcher.validate("https://github.com/a/b")).not.toThrow();
  });

  it("rejects non-https URLs", () => {
    expect(() => fetcher.validate("http://github.com/a/b")).toThrow(/only supports public HTTPS repos/);
    expect(() => fetcher.validate("ssh://git@github.com/a/b")).toThrow(/only supports public HTTPS repos/);
    expect(() => fetcher.validate("file:///etc/passwd")).toThrow(/only supports public HTTPS repos/);
  });

  it("rejects credentials in URLs", () => {
    expect(() => fetcher.validate("https://user:pass@github.com/a/b")).toThrow(/credentials in URL are not allowed/);
    expect(() => fetcher.validate("https://user@github.com/a/b")).toThrow(/credentials in URL are not allowed/);
  });

  it("rejects fragments in URLs", () => {
    expect(() => fetcher.validate("https://github.com/a/b#fragment")).toThrow(/fragments are not allowed/);
  });

  it("rejects alternate IP URL forms and ambiguities", () => {
    expect(() => fetcher.validate("https://127.1/a/b")).toThrow(/alternate numeric IPv4 URL forms/);
    expect(() => fetcher.validate("https://0177.0.0.1/a/b")).toThrow(/alternate numeric IPv4 URL forms/);
    expect(() => fetcher.validate("https://2130706433/a/b")).toThrow(/alternate numeric IPv4 URL forms/);
    expect(() => fetcher.validate("https://0x7f000001/a/b")).toThrow(/alternate numeric IPv4 URL forms/);
  });

  it("rejects control characters and backslashes", () => {
    expect(() => fetcher.validate("https://github.com/a/b\\c")).toThrow(/backslash and @ are not allowed/);
    expect(() => fetcher.validate("https://github.com/a/b\n")).toThrow(/control characters are not allowed/);
    expect(() => fetcher.validate("https://github.com/a/b\r")).toThrow(/control characters are not allowed/);
  });

  it("keeps validation errors free of embedded credentials and asserts it throws", () => {
    expect.assertions(3);
    try {
      fetcher.validate("https://secretuser:secretpass@github.com/repo");
    } catch (e: any) {
      expect(e).toBeDefined();
      expect(e.message).not.toContain("secretuser");
      expect(e.message).not.toContain("secretpass");
    }
  });

  it("synchronously rejects literal non-public IPs in validate()", () => {
    expect(() => fetcher.validate("https://127.0.0.1/a/b")).toThrow(/SSRF Address Policy Violation/);
    expect(() => fetcher.validate("https://[::1]/a/b")).toThrow(/SSRF Address Policy Violation/);
    expect(() => fetcher.validate("https://[2001:db8::1]/a/b")).toThrow(/SSRF Address Policy Violation/);
    // valid ipv6 should not throw
    expect(() => fetcher.validate("https://[2606:4700:4700::1111]/a/b")).not.toThrow();
  });

  it("does not synchronously reject non-public IPs if ssrfCheck is false", () => {
    const fetcherNoSSRF = new GitSourceFetcher({ ssrfCheck: false });
    expect(() => fetcherNoSSRF.validate("https://127.0.0.1/a/b")).not.toThrow();
  });

  it("verifies ssrfCheck: false still rejects credentials, fragments, alternate numeric URLs, and invalid branches", () => {
    const fetcherNoSSRF = new GitSourceFetcher({ ssrfCheck: false });
    expect(() => fetcherNoSSRF.validate("https://user:pass@example.com/repo")).toThrow(/credentials in URL are not allowed/);
    expect(() => fetcherNoSSRF.validate("https://example.com/repo#frag")).toThrow(/fragments are not allowed/);
    expect(() => fetcherNoSSRF.validate("https://0177.0.0.1/repo")).toThrow(/alternate numeric IPv4 URL forms/);
    expect(() => fetcherNoSSRF.validateBranch("main.lock")).toThrow(/invalid branch/);
  });

  it("validates safe branch names", () => {
    expect(() => fetcher.validateBranch("main")).not.toThrow();
    expect(() => fetcher.validateBranch("feat/branch")).not.toThrow();
    expect(() => fetcher.validateBranch("foo@bar")).not.toThrow(); // Valid ordinary branch containing @
  });

  describe("rejects unsafe branch names", () => {
    it.each([
      "-o", // leading dash
      "main..other", // ..
      "main/.other", // /.
      ".main", // leading dot
      "main.", // trailing dot
      "main.lock", // ends with .lock
      "main.lock/foo", // contains .lock/
      "main//foo", // repeated slash
      "main ", // space
      "main\n", // control char
      "@", // single @
      "foo@{bar" // @{
    ])("rejects branch '%s'", (branch) => {
      expect(() => fetcher.validateBranch(branch)).toThrow(/invalid branch/);
    });
  });
});

describe("resolveAndValidate direct synthetic DNS tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects public A plus private AAAA via default DNS resolver", async () => {
    vi.mocked(dns.resolve4).mockResolvedValueOnce(["8.8.8.8"]);
    vi.mocked(dns.resolve6).mockResolvedValueOnce(["::1"]);
    await expect(resolveAndValidate("example-dns.com", { ssrfCheck: true })).rejects.toThrow(/SSRF Address Policy Violation/);
    expect(dns.resolve4).toHaveBeenCalledWith("example-dns.com");
    expect(dns.resolve6).toHaveBeenCalledWith("example-dns.com");
  });

  it("rejects public A plus failing AAAA lookup via default DNS resolver", async () => {
    vi.mocked(dns.resolve4).mockResolvedValueOnce(["8.8.8.8"]);
    const err = new Error("SERVFAIL");
    (err as any).code = "SERVFAIL";
    vi.mocked(dns.resolve6).mockRejectedValueOnce(err);
    await expect(resolveAndValidate("example-dns2.com", { ssrfCheck: true })).rejects.toThrow(/SERVFAIL/);
  });

  it("fails closed on empty DNS results", async () => {
    vi.mocked(dns.resolve4).mockResolvedValueOnce([]);
    vi.mocked(dns.resolve6).mockResolvedValueOnce([]);
    await expect(resolveAndValidate("empty-dns.com", { ssrfCheck: true })).rejects.toThrow(/DNS resolution failed or returned empty data/);
  });

  it("rejects invalid returned IPs", async () => {
    vi.mocked(dns.resolve4).mockResolvedValueOnce(["not-an-ip"]);
    vi.mocked(dns.resolve6).mockResolvedValueOnce([]);
    await expect(resolveAndValidate("invalid-dns.com", { ssrfCheck: true })).rejects.toThrow(/Invalid IP address returned by DNS/);
  });

  it("resolves all-public A/AAAA successfully", async () => {
    vi.mocked(dns.resolve4).mockResolvedValueOnce(["8.8.8.8"]);
    vi.mocked(dns.resolve6).mockResolvedValueOnce(["2001:4860::8888"]);
    const res = await resolveAndValidate("public-dns.com", { ssrfCheck: true });
    expect(res).toEqual(["8.8.8.8", "2001:4860::8888"]);
  });

  it("resolves successfully with ENODATA for one family", async () => {
    vi.mocked(dns.resolve4).mockResolvedValueOnce(["8.8.8.8"]);
    const err = new Error("ENODATA");
    (err as any).code = "ENODATA";
    vi.mocked(dns.resolve6).mockRejectedValueOnce(err);
    const res = await resolveAndValidate("enodata-dns.com", { ssrfCheck: true });
    expect(res).toEqual(["8.8.8.8"]);
  });

  it("allows private-address override when ssrfCheck is false", async () => {
    vi.mocked(dns.resolve4).mockResolvedValueOnce(["192.168.1.1"]);
    vi.mocked(dns.resolve6).mockResolvedValueOnce([]);
    const res = await resolveAndValidate("private-override.com", { ssrfCheck: false });
    expect(res).toEqual(["192.168.1.1"]);
  });
});
