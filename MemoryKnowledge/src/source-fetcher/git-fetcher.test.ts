import { beforeEach, describe, expect, it, vi } from "vitest";

import { GitSourceFetcher } from "./git-fetcher.js";
import type { GitAuthMaterial } from "./git-auth.js";

/**
 * fetcher 的两个关注点分开测：
 *   - validate()：纯逻辑，安全边界都在这里（协议白名单 / 锚定 host 白名单 /
 *     内嵌凭证拒绝 / 私有地址），不需要 mock。
 *   - fetch()/sync()：认证是否被正确注入、以及**无凭证时是否完全不碰 env**
 *     （这条是公开仓库路径的向后兼容回归护栏）。
 */

// ───────────────────────── simple-git mock ─────────────────────────

const mocks = vi.hoisted(() => {
  const envCalls: Array<Record<string, unknown>> = [];
  const argvCalls: unknown[][] = [];

  function makeInstance(): Record<string, unknown> {
    const inst: Record<string, unknown> = {};
    inst.env = (e: Record<string, unknown>) => {
      envCalls.push(e);
      return inst;
    };
    inst.clone = async (...args: unknown[]) => {
      argvCalls.push(args);
    };
    inst.fetch = async (...args: unknown[]) => {
      argvCalls.push(args);
    };
    inst.reset = async () => undefined;
    inst.clean = async () => undefined;
    inst.revparse = async () => "abcdef1234567890";
    inst.raw = async (...args: unknown[]) => {
      argvCalls.push(args);
      return "";
    };
    return inst;
  }

  return { envCalls, argvCalls, makeInstance, simpleGit: vi.fn(() => makeInstance()) };
});

vi.mock("simple-git", () => ({
  default: mocks.simpleGit,
  CleanOptions: { FORCE: "f", RECURSIVE: "d" },
  ResetMode: { HARD: "--hard" },
}));

beforeEach(() => {
  mocks.envCalls.length = 0;
  mocks.argvCalls.length = 0;
  mocks.simpleGit.mockClear();
});

// ───────────────────────── validate() ─────────────────────────

describe("GitSourceFetcher.validate — 协议白名单", () => {
  const fetcher = new GitSourceFetcher({ ssrfCheck: false });

  it("接受 https / ssh / scp-like", () => {
    expect(() => fetcher.validate("https://git.example.com/o/r.git")).not.toThrow();
    expect(() => fetcher.validate("ssh://git@git.example.com:2222/o/r.git")).not.toThrow();
    expect(() => fetcher.validate("git@git.example.com:o/r.git")).not.toThrow();
  });

  it("拒绝无法识别的协议与非法 host", () => {
    for (const bad of ["file:///tmp/x", "ftp://host/x", "not a url", "", "git@evil;curl${IFS}x:y"]) {
      expect(() => fetcher.validate(bad), bad).toThrow(/invalid repo_url/);
    }
  });

  it("http 只在 host 命中白名单时放行", () => {
    const strict = new GitSourceFetcher({ ssrfCheck: false });
    expect(() => strict.validate("http://git.example.com/o/r.git")).toThrow(/must use https/);

    const allowHttp = new GitSourceFetcher({ ssrfCheck: false, allowedHosts: ["git.example.com"] });
    expect(() => allowHttp.validate("http://git.example.com/o/r.git")).not.toThrow();
  });
});

describe("GitSourceFetcher.validate — 拒绝 URL 内嵌凭证", () => {
  const fetcher = new GitSourceFetcher({ ssrfCheck: false });

  it("https://user:token@host 被拒（历史写法会把 token 落到 .git/config）", () => {
    expect(() => fetcher.validate("https://user:tok@git.example.com/o/r.git")).toThrow(/must not embed credentials/);
  });

  it("https://token@host（token 在 username 位）同样被拒", () => {
    expect(() => fetcher.validate("https://ghp_x@git.example.com/o/r.git")).toThrow(/must not embed credentials/);
  });

  it("scp-like 的 git@ 不算内嵌凭证", () => {
    expect(() => fetcher.validate("git@git.example.com:o/r.git")).not.toThrow();
  });
});

describe("GitSourceFetcher.validate — SSRF 与 host 白名单", () => {
  it("开启 SSRF 时拒绝内网 / 环回（含 IPv6）", () => {
    const fetcher = new GitSourceFetcher({ ssrfCheck: true });
    for (const bad of [
      "https://127.0.0.1/o/r.git",
      "https://10.1.2.3/o/r.git",
      "https://169.254.169.254/latest/meta-data.git",
      "https://[::1]/o/r.git",
      "git@192.168.1.10:o/r.git",
    ]) {
      expect(() => fetcher.validate(bad), bad).toThrow(/private\/loopback/);
    }
  });

  it("白名单命中的内网 host 放行（企业内网 GitLab 场景）", () => {
    const fetcher = new GitSourceFetcher({
      ssrfCheck: true,
      allowedHosts: ["gitlab.corp.example.com", "*.internal.example.com"],
    });
    expect(() => fetcher.validate("https://gitlab.corp.example.com/o/r.git")).not.toThrow();
    expect(() => fetcher.validate("https://gitlab.internal.example.com/o/r.git")).not.toThrow();
    expect(() => fetcher.validate("git@gitlab.internal.example.com:o/r.git")).not.toThrow();
  });

  it("白名单只放行它声明的 host，内网地址该拦还是拦", () => {
    const fetcher = new GitSourceFetcher({ ssrfCheck: true, allowedHosts: ["*.internal.example.com"] });
    // 命中白名单 → 放行
    expect(() => fetcher.validate("https://gitlab.internal.example.com/o/r.git")).not.toThrow();
    // 未命中白名单的内网地址 → 仍被 SSRF 拦下
    expect(() => fetcher.validate("https://10.0.0.1/o/r.git")).toThrow(/private\/loopback/);
    // 后缀伪装 / 前缀同形都不算命中（这些 host 本身是公网，关键是不能让它们
    // 借白名单之名放行内网语义 —— 见 git-url.test.ts 里对锚定匹配的直接断言）
    expect(() => fetcher.validate("https://gitlab.internal.example.com.attacker.com/o/r.git")).not.toThrow();
    expect(() => fetcher.validate("https://evilinternal.example.com/o/r.git")).not.toThrow();
  });

  it("KNOWLEDGE_SSRF_CHECK 语义不变：显式 ssrfCheck 优先", () => {
    expect(() => new GitSourceFetcher({ ssrfCheck: false }).validate("https://10.0.0.1/o/r.git")).not.toThrow();
    expect(() => new GitSourceFetcher({ ssrfCheck: true }).validate("https://10.0.0.1/o/r.git")).toThrow();
  });
});

// ───────────────────────── fetch() / sync() ─────────────────────────

describe("GitSourceFetcher.fetch — 认证注入", () => {
  const fetcher = new GitSourceFetcher({ ssrfCheck: false });
  const httpsAuth: GitAuthMaterial = { kind: "https_token", token: "ghp_SECRET_TOKEN_VALUE" };

  it("无 auth 时完全不调用 .env()（公开仓库路径逐字节不变）", async () => {
    await fetcher.fetch("https://git.example.com/o/r.git", "main", "/tmp/x");
    expect(mocks.envCalls).toHaveLength(0);
  });

  it("带 auth 时注入 env，且 token 不出现在 argv 里", async () => {
    await fetcher.fetch("https://git.example.com/o/r.git", "main", "/tmp/x", { auth: httpsAuth });

    expect(mocks.envCalls).toHaveLength(1);
    expect(String(mocks.envCalls[0].GIT_CONFIG_VALUE_0)).toContain("Authorization: Basic");

    // argv（clone 的 URL / 分支等）里绝不能出现 token
    expect(JSON.stringify(mocks.argvCalls)).not.toContain(httpsAuth.token);
  });

  it("默认浅克隆单分支", async () => {
    await fetcher.fetch("https://git.example.com/o/r.git", "release", "/tmp/x");
    expect(mocks.argvCalls[0][0]).toBe("https://git.example.com/o/r.git");
    expect(mocks.argvCalls[0][2]).toMatchObject({ "--depth": 1, "--branch": "release" });
  });
});

describe("GitSourceFetcher.sync — 认证注入", () => {
  const fetcher = new GitSourceFetcher({ ssrfCheck: false });

  it("无 auth 时不调用 .env()", async () => {
    await fetcher.sync("https://git.example.com/o/r.git", "main", "/tmp/x");
    expect(mocks.envCalls).toHaveLength(0);
  });

  it("带 auth 时注入 env（simple-git 的 env 是实例态，必须每次新建）", async () => {
    await fetcher.sync("https://git.example.com/o/r.git", "main", "/tmp/x", {
      auth: { kind: "https_token", token: "ghp_SECRET_TOKEN_VALUE" },
    });
    expect(mocks.envCalls).toHaveLength(1);
    expect(JSON.stringify(mocks.argvCalls)).not.toContain("ghp_SECRET_TOKEN_VALUE");
  });
});

describe("GitSourceFetcher.probe", () => {
  const fetcher = new GitSourceFetcher({ ssrfCheck: false });

  it("无 auth 时走匿名 ls-remote", async () => {
    const res = await fetcher.probe("https://git.example.com/o/r.git", undefined);
    expect(res.ok).toBe(true);
    expect(mocks.argvCalls[0][0]).toEqual(["ls-remote", "--heads", "https://git.example.com/o/r.git"]);
    expect(mocks.envCalls).toHaveLength(0);
  });

  it("带 auth 时注入 env，且 token 不出现在 argv", async () => {
    const token = "ghp_SECRET_TOKEN_VALUE";
    await fetcher.probe("https://git.example.com/o/r.git", "main", { auth: { kind: "https_token", token } });
    expect(mocks.envCalls).toHaveLength(1);
    expect(JSON.stringify(mocks.argvCalls)).not.toContain(token);
  });

  it("非法 URL 直接抛（不发起探测）", async () => {
    const strict = new GitSourceFetcher({ ssrfCheck: true });
    await expect(strict.probe("https://10.0.0.1/o/r.git", undefined)).rejects.toThrow(/private\/loopback/);
  });
});
