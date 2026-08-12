/**
 * URL 安全测试（949spec §9 / §13 / §18）。
 * - userinfo URL 必须被拒绝（CREDENTIAL_IN_URL_NOT_ALLOWED）；
 * - http 明文、控制字符、非法协议必须被拒绝；
 * - 字面量禁止地址（loopback/RFC1918/link-local/metadata）必须被拒绝；
 * - DNS 解析出的任一禁止地址必须被拒绝（resolveOverride 模拟）；
 * - 规范化：scp 风格、默认端口省略、host 小写。
 */

import { describe, it, expect } from "vitest";
import {
  canonicalizeGitUrl,
  assertSafeRemote,
  isForbiddenAddress,
  GitUrlError,
  GIT_URL_ERROR,
} from "../url-security.js";

describe("canonicalizeGitUrl (§18)", () => {
  it("normalizes https URL (host lowercase, no userinfo)", () => {
    const r = canonicalizeGitUrl("https://GitHub.COM/org/repo.git");
    expect(r).toMatchObject({ protocol: "https", url: "https://github.com/org/repo.git", host: "github.com" });
  });

  it("omits default https port", () => {
    expect(canonicalizeGitUrl("https://github.com:443/org/repo.git").url).toBe("https://github.com/org/repo.git");
  });

  it("keeps non-default port", () => {
    const r = canonicalizeGitUrl("https://git.example.com:8443/org/repo.git");
    expect(r.url).toBe("https://git.example.com:8443/org/repo.git");
    expect(r.port).toBe(8443);
  });

  it("normalizes scp-style ssh url", () => {
    const r = canonicalizeGitUrl("git@github.com:org/repo.git");
    expect(r).toMatchObject({ protocol: "ssh", url: "ssh://git@github.com/org/repo.git" });
  });

  it("rejects userinfo in url (§9 CREDENTIAL_IN_URL_NOT_ALLOWED)", () => {
    try {
      canonicalizeGitUrl("https://user:TOKEN@github.com/org/repo.git");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitUrlError);
      expect((err as GitUrlError).code).toBe(GIT_URL_ERROR.CREDENTIAL_IN_URL_NOT_ALLOWED);
    }
  });

  it("rejects plaintext http (§3 Non-Goals)", () => {
    try {
      canonicalizeGitUrl("http://github.com/org/repo.git");
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as GitUrlError).code).toBe(GIT_URL_ERROR.UNSUPPORTED_PROTOCOL);
    }
  });

  it("rejects newline injection", () => {
    try {
      canonicalizeGitUrl("https://github.com/org/repo.git\nx");
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as GitUrlError).code).toBe(GIT_URL_ERROR.MALFORMED_URL);
    }
  });

  it("rejects shell metacharacters", () => {
    for (const evil of ["https://github.com/org/repo.git;rm -rf /", "https://github.com/org/$(id).git"]) {
      expect(() => canonicalizeGitUrl(evil)).toThrow(GitUrlError);
    }
  });

  it("rejects empty path", () => {
    expect(() => canonicalizeGitUrl("https://github.com/")).toThrow(GitUrlError);
  });
});

describe("isForbiddenAddress (§13.1 forbidden classes)", () => {
  const blocked = [
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "169.254.0.1",
    "224.0.0.1", // multicast
    "::1",
    "::",
    "fe80::1",
    "fc00::1", // ULA
    "ff02::1", // multicast
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => {
      expect(isForbiddenAddress(ip).blocked).toBe(true);
    });
  }

  const allowed = ["8.8.8.8", "1.1.1.1", "140.82.112.3", "2606:4700:4700::1111"];
  for (const ip of allowed) {
    it(`allows ${ip}`, () => {
      expect(isForbiddenAddress(ip).blocked).toBe(false);
    });
  }
});

describe("assertSafeRemote (§13.1 DNS resolution)", () => {
  it("blocks literal private IP", async () => {
    const repo = canonicalizeGitUrl("https://127.0.0.1/org/repo.git");
    try {
      await assertSafeRemote(repo);
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as GitUrlError).code).toBe(GIT_URL_ERROR.PRIVATE_ADDRESS_BLOCKED);
    }
  });

  it("blocks hostname resolving to forbidden address (DNS rebinding layer)", async () => {
    const repo = canonicalizeGitUrl("https://evil.example.com/org/repo.git");
    try {
      await assertSafeRemote(repo, { resolveOverride: async () => ["10.0.0.5"] });
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as GitUrlError).code).toBe(GIT_URL_ERROR.DNS_RESOLUTION_BLOCKED);
    }
  });

  it("blocks mixed A/AAAA where one address is forbidden", async () => {
    const repo = canonicalizeGitUrl("https://mixed.example.com/org/repo.git");
    try {
      await assertSafeRemote(repo, { resolveOverride: async () => ["8.8.8.8", "169.254.169.254"] });
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as GitUrlError).code).toBe(GIT_URL_ERROR.DNS_RESOLUTION_BLOCKED);
    }
  });

  it("allows hostname resolving only to public addresses", async () => {
    const repo = canonicalizeGitUrl("https://github.com/org/repo.git");
    const addrs = await assertSafeRemote(repo, { resolveOverride: async () => ["140.82.112.3"] });
    expect(addrs).toEqual(["140.82.112.3"]);
  });

  it("fails closed when DNS cannot resolve", async () => {
    const repo = canonicalizeGitUrl("https://nx.example.com/org/repo.git");
    try {
      await assertSafeRemote(repo, { resolveOverride: async () => [] });
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as GitUrlError).code).toBe(GIT_URL_ERROR.DNS_RESOLUTION_FAILED);
    }
  });

  it("can be disabled via enabled=false (env override path)", async () => {
    const repo = canonicalizeGitUrl("https://127.0.0.1/org/repo.git");
    await expect(assertSafeRemote(repo, { enabled: false })).resolves.toEqual([]);
  });
});
