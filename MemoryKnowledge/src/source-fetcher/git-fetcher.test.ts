import { describe, it, expect } from "vitest";
import { GitSourceFetcher } from "./git-fetcher.js";

describe("GitSourceFetcher SSRF validation", () => {
  const fetcher = new GitSourceFetcher();

  it("blocks standard IPv4 private and loopback addresses", () => {
    expect(() => fetcher.validate("https://127.0.0.1/repo.git")).toThrow(/private\/loopback/);
    expect(() => fetcher.validate("https://localhost/repo.git")).toThrow(/private\/loopback/);
    expect(() => fetcher.validate("https://10.0.0.1/repo.git")).toThrow(/private\/loopback/);
    expect(() => fetcher.validate("https://192.168.1.1/repo.git")).toThrow(/private\/loopback/);
    expect(() => fetcher.validate("https://172.16.0.1/repo.git")).toThrow(/private\/loopback/);
    expect(() => fetcher.validate("https://169.254.169.254/repo.git")).toThrow(/private\/loopback/);
  });

  it("blocks IPv6 loopback, unspecified, link-local, and unique-local addresses", () => {
    expect(() => fetcher.validate("https://[::1]/repo.git")).toThrow(/private\/loopback/);
    expect(() => fetcher.validate("https://[::]/repo.git")).toThrow(/private\/loopback/);
    expect(() => fetcher.validate("https://[fe80::1]/repo.git")).toThrow(/private\/loopback/);
    expect(() => fetcher.validate("https://[fc00::1]/repo.git")).toThrow(/private\/loopback/);
    expect(() => fetcher.validate("https://[fd00::1]/repo.git")).toThrow(/private\/loopback/);
  });

  it("blocks IPv4-mapped IPv6 internal and cloud metadata addresses", () => {
    expect(() => fetcher.validate("https://[::ffff:127.0.0.1]/repo.git")).toThrow(/private\/loopback/);
    expect(() => fetcher.validate("https://[::ffff:169.254.169.254]/repo.git")).toThrow(/private\/loopback/);
    expect(() => fetcher.validate("https://[::ffff:10.0.0.1]/repo.git")).toThrow(/private\/loopback/);
    expect(() => fetcher.validate("https://[::ffff:192.168.1.1]/repo.git")).toThrow(/private\/loopback/);
    expect(() => fetcher.validate("https://[::ffff:172.16.0.1]/repo.git")).toThrow(/private\/loopback/);
  });

  it("permits public external git repositories", () => {
    expect(() => fetcher.validate("https://github.com/TencentCloud/TencentDB-Agent-Memory.git")).not.toThrow();
    expect(() => fetcher.validate("https://gitlab.com/example/repo.git")).not.toThrow();
  });
});
