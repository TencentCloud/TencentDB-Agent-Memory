import { describe, expect, it } from "vitest";

import {
  hasEmbeddedCredentials,
  hostMatchesPattern,
  isAllowedHost,
  isPrivateHost,
  isValidHost,
  normalizeHost,
  parseAllowedHosts,
  parseGitUrl,
} from "./git-url.js";

describe("normalizeHost", () => {
  it("小写化并去掉 FQDN 尾点", () => {
    expect(normalizeHost("Corp.Example.COM.")).toBe("corp.example.com");
  });

  it("去掉 IPv6 方括号与 zone id", () => {
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("fe80::1%en0")).toBe("fe80::1");
  });
});

describe("isValidHost", () => {
  it("接受普通域名 / 下划线内网名 / IPv4", () => {
    expect(isValidHost("git.example.com")).toBe(true);
    expect(isValidHost("git_server")).toBe(true);
    expect(isValidHost("10.0.0.1")).toBe(true);
    expect(isValidHost("::1")).toBe(true);
  });

  it("拒绝含 shell 元字符的 host（命令注入的第一道防线）", () => {
    for (const bad of ["evil;curl", "evil$(id)", "evil`id`", "evil host", "evil'x", 'evil"x', "evil|x", "evil&x"]) {
      expect(isValidHost(bad), bad).toBe(false);
    }
  });
});

describe("parseGitUrl", () => {
  it("解析 https", () => {
    const parsed = parseGitUrl("https://git.example.com/o/r.git");
    expect(parsed).toMatchObject({ protocol: "https", host: "git.example.com", path: "/o/r.git" });
  });

  it("解析 ssh:// 并保留端口与 user", () => {
    const parsed = parseGitUrl("ssh://git@git.example.com:2222/o/r.git");
    expect(parsed).toMatchObject({ protocol: "ssh", host: "git.example.com", port: 2222, user: "git" });
  });

  it("解析 scp-like（git@host:path）", () => {
    const parsed = parseGitUrl("git@git.example.com:group/sub/r.git");
    expect(parsed).toMatchObject({ protocol: "scp", host: "git.example.com", path: "group/sub/r.git", user: "git" });
  });

  it("scp-like 正则不会误判带 scheme 的 URL", () => {
    // 加负向前瞻前，`ssh://git@host:2222/x` 会被 scp-like 正则抢走
    expect(parseGitUrl("ssh://git@host:2222/x")?.protocol).toBe("ssh");
    expect(parseGitUrl("https://host:8443/x")?.protocol).toBe("https");
    expect(parseGitUrl("file:///tmp/x")).toBeNull();
    expect(parseGitUrl("ftp://host/x")).toBeNull();
  });

  it("拒绝含空格/控制字符的 URL", () => {
    expect(parseGitUrl("https://host/a b/r.git")).toBeNull();
    expect(parseGitUrl("")).toBeNull();
  });

  it("拒绝 host 非法的 URL（含 scp-like 的注入样本）", () => {
    expect(parseGitUrl("git@evil;curl${IFS}attacker:x")).toBeNull();
    expect(parseGitUrl("git@evil$(id):x")).toBeNull();
  });
});

describe("hasEmbeddedCredentials", () => {
  it("https 带 user 或 password 都算内嵌凭证", () => {
    expect(hasEmbeddedCredentials("https://user:tok@h/x.git")).toBe(true);
    expect(hasEmbeddedCredentials("https://ghp_tok@h/x.git")).toBe(true);
  });

  it("干净的 https 与 scp-like 不算", () => {
    expect(hasEmbeddedCredentials("https://h/x.git")).toBe(false);
    expect(hasEmbeddedCredentials("git@h:x.git")).toBe(false);
    expect(hasEmbeddedCredentials("ssh://git@h:22/x.git")).toBe(false);
  });
});

describe("isPrivateHost", () => {
  it("覆盖 IPv4 私有 / 环回 / link-local / CGNAT", () => {
    for (const h of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "0.0.0.0", "169.254.169.254", "100.64.0.1", "localhost"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });

  it("不误伤公网地址（含 172.32 边界）", () => {
    for (const h of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "github.com", "1.1.1.1"]) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });

  it("覆盖 IPv6 回环 / link-local / ULA —— 历史实现漏判的那批", () => {
    for (const h of ["::1", "::", "[::1]", "fe80::1", "fe80::abcd", "fc00::1", "fd12:3456::1"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });

  it("覆盖 IPv4-mapped IPv6（点分与十六进制两种形态）", () => {
    // `new URL("https://[::ffff:127.0.0.1]/x").hostname` 会被规范化成 ::ffff:7f00:1
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateHost("::ffff:7f00:1")).toBe(true);
    expect(isPrivateHost("::ffff:10.0.0.5")).toBe(true);
  });
});

describe("hostMatchesPattern / isAllowedHost", () => {
  it("精确匹配", () => {
    expect(hostMatchesPattern("git.corp.example.com", "git.corp.example.com")).toBe(true);
    expect(hostMatchesPattern("other.corp.example.com", "git.corp.example.com")).toBe(false);
  });

  it("*.suffix 只匹配单层 label —— 这两个绕过样本必须被拒", () => {
    expect(hostMatchesPattern("git.corp.example.com", "*.corp.example.com")).toBe(true);
    // 若用 endsWith/includes 实现，下面两个都会命中
    expect(hostMatchesPattern("x.corp.example.com.attacker.com", "*.corp.example.com")).toBe(false);
    expect(hostMatchesPattern("evilcorp.example.com", "*.corp.example.com")).toBe(false);
    // 通配不匹配裸后缀本体
    expect(hostMatchesPattern("corp.example.com", "*.corp.example.com")).toBe(false);
  });

  it("不支持的通配写法一律不命中（fail-closed）", () => {
    expect(hostMatchesPattern("git.corp.example.com", "*")).toBe(false);
    expect(hostMatchesPattern("git.corp.example.com", "git.*.example.com")).toBe(false);
    expect(hostMatchesPattern("git.corp.example.com", "*corp.example.com")).toBe(false);
  });

  it("大小写与尾点差异被归一化吃掉", () => {
    expect(hostMatchesPattern("Git.Corp.Example.COM.", "*.corp.example.com")).toBe(true);
  });

  it("isAllowedHost 遍历多条", () => {
    const list = ["a.example.com", "*.corp.example.com"];
    expect(isAllowedHost("git.corp.example.com", list)).toBe(true);
    expect(isAllowedHost("a.example.com", list)).toBe(true);
    expect(isAllowedHost("b.example.com", list)).toBe(false);
    expect(isAllowedHost("anything", [])).toBe(false);
  });
});

describe("parseAllowedHosts", () => {
  it("逗号分隔、去空白、丢空项", () => {
    expect(parseAllowedHosts(" a.com , *.b.com ,, ")).toEqual(["a.com", "*.b.com"]);
  });

  it("空/未配置 → 空数组", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("")).toEqual([]);
  });
});
