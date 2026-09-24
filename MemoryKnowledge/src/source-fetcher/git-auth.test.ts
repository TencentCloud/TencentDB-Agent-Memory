import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_HTTPS_USERNAME,
  assertUsablePrivateKey,
  buildGitAuthEnv,
  cleanupStaleGitAuthDirs,
  shellQuote,
  stripSimpleGitDebug,
  GIT_AUTH_TMP_PREFIX,
} from "./git-auth.js";

/**
 * 这批断言守的是三条历史踩过的坑：
 *   1. 盲 `{...process.env}` 会把 GIT_PAGER/GIT_TRACE* 带进去（护栏 + 泄漏）
 *   2. HTTPS token 必须只出现在 GIT_CONFIG_VALUE_0（不进 URL / argv / .git/config）
 *   3. SSH 私钥必须 0600，且临时目录无论如何都要被清掉
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("shellQuote", () => {
  it("单引号包裹并转义内部单引号", () => {
    expect(shellQuote("/tmp/a b")).toBe("'/tmp/a b'");
    expect(shellQuote("/tmp/a'b")).toBe("'/tmp/a'\\''b'");
  });
});

describe("buildGitAuthEnv — HTTPS", () => {
  const material = { kind: "https_token" as const, token: "ghp_TESTTOKEN1234567890" };

  it("token 只出现在 GIT_CONFIG_VALUE_0，且用 Basic 编码", () => {
    const plan = buildGitAuthEnv(material);
    cleanups.push(plan.cleanup);

    const value = plan.env.GIT_CONFIG_VALUE_0!;
    expect(value).toBe(`Authorization: Basic ${Buffer.from(`oauth2:${material.token}`).toString("base64")}`);
    // 除了这一个变量，env 里不应再出现 token
    const rest = { ...plan.env, GIT_CONFIG_VALUE_0: "" };
    expect(JSON.stringify(rest)).not.toContain(material.token);
  });

  it("清空 credential.helper（否则 macOS osxkeychain 会把 token 缓存进系统钥匙串）", () => {
    const plan = buildGitAuthEnv(material);
    cleanups.push(plan.cleanup);
    expect(plan.env.GIT_CONFIG_KEY_1).toBe("credential.helper");
    expect(plan.env.GIT_CONFIG_VALUE_1).toBe("");
  });

  it("username 可覆盖（GitHub App installation token 需 x-access-token）", () => {
    const plan = buildGitAuthEnv({ ...material, username: "x-access-token" });
    cleanups.push(plan.cleanup);
    expect(plan.env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from(`x-access-token:${material.token}`).toString("base64")}`,
    );
  });

  it("默认 username 是 oauth2", () => {
    const plan = buildGitAuthEnv(material);
    cleanups.push(plan.cleanup);
    const decoded = Buffer.from(plan.env.GIT_CONFIG_VALUE_0!.split(" ")[2], "base64").toString("utf8");
    expect(decoded.startsWith(`${DEFAULT_HTTPS_USERNAME}:`)).toBe(true);
  });

  it("env 走白名单：保留 PATH，剔除 GIT_PAGER / GIT_TRACE* / GIT_ASKPASS", () => {
    const injected = {
      GIT_PAGER: "less",
      GIT_TRACE_CURL: "1",
      GIT_CURL_VERBOSE: "1",
      GIT_ASKPASS: "/tmp/leak.sh",
    };
    const previous = process.env.GIT_CONFIG_COUNT;
    Object.assign(process.env, injected, { GIT_CONFIG_COUNT: "9" });
    try {
      const plan = buildGitAuthEnv(material);
      cleanups.push(plan.cleanup);

      if (process.env.PATH) expect(plan.env.PATH).toBe(process.env.PATH);
      for (const key of Object.keys(injected)) {
        expect(plan.env[key], key).toBeUndefined();
      }
      // 继承来的 GIT_CONFIG_COUNT 不能顶掉我们自己的
      expect(plan.env.GIT_CONFIG_COUNT).toBe("2");
    } finally {
      for (const key of Object.keys(injected)) delete process.env[key];
      if (previous === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = previous;
    }
  });

  it("只放行本次真正用到的 unsafe 类别", () => {
    const plan = buildGitAuthEnv(material);
    cleanups.push(plan.cleanup);
    expect(plan.unsafe).toEqual({ allowUnsafeConfigEnvCount: true, allowUnsafeCredentialHelper: true });
    expect(plan.unsafe.allowUnsafeSshCommand).toBeUndefined();
    expect(plan.unsafe.allowUnsafePager).toBeUndefined();
  });

  it("缺少 token 直接抛错，而不是产出空认证", () => {
    expect(() => buildGitAuthEnv({ kind: "https_token", token: "  " })).toThrow(/token/);
  });

  it("cleanup 是 no-op（无临时文件）", () => {
    const plan = buildGitAuthEnv(material);
    expect(() => plan.cleanup()).not.toThrow();
  });
});

describe("buildGitAuthEnv — SSH", () => {
  const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n";

  it("私钥落盘为 0600，且路径被 shell-quote", () => {
    const plan = buildGitAuthEnv({ kind: "ssh_key", privateKey: PRIVATE_KEY });
    cleanups.push(plan.cleanup);

    const m = /-i '([^']+)'/.exec(plan.env.GIT_SSH_COMMAND!);
    expect(m, plan.env.GIT_SSH_COMMAND).not.toBeNull();
    const keyPath = m![1];

    expect(existsSync(keyPath)).toBe(true);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    // 私钥本体不应出现在 env 里（只在文件里）
    expect(JSON.stringify(plan.env)).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA");
  });

  it("必须带 BatchMode=yes（否则认证失败会挂在密码提示上）与 IdentitiesOnly=yes", () => {
    const plan = buildGitAuthEnv({ kind: "ssh_key", privateKey: PRIVATE_KEY });
    cleanups.push(plan.cleanup);
    const cmd = plan.env.GIT_SSH_COMMAND!;
    expect(cmd).toContain("-o BatchMode=yes");
    expect(cmd).toContain("-o IdentitiesOnly=yes");
    expect(cmd).toContain("-o StrictHostKeyChecking=accept-new");
  });

  it("strictHostKey 切换为 yes", () => {
    const plan = buildGitAuthEnv({ kind: "ssh_key", privateKey: PRIVATE_KEY }, { strictHostKey: true });
    cleanups.push(plan.cleanup);
    expect(plan.env.GIT_SSH_COMMAND).toContain("-o StrictHostKeyChecking=yes");
  });

  it("known_hosts 用固定单一路径（绝不按 host 拼接）", () => {
    const plan = buildGitAuthEnv(
      { kind: "ssh_key", privateKey: PRIVATE_KEY },
      { knownHostsPath: "/tmp/kg-test-known-hosts/known_hosts" },
    );
    cleanups.push(plan.cleanup);

    expect(plan.env.GIT_SSH_COMMAND).toContain("-o UserKnownHostsFile='/tmp/kg-test-known-hosts/known_hosts'");
    // 父目录会被预创建
    expect(existsSync(dirname("/tmp/kg-test-known-hosts/known_hosts"))).toBe(true);
  });

  it("cleanup 删掉临时目录，且可重复调用", () => {
    const plan = buildGitAuthEnv({ kind: "ssh_key", privateKey: PRIVATE_KEY });
    const keyPath = /-i '([^']+)'/.exec(plan.env.GIT_SSH_COMMAND!)![1];
    const dir = dirname(keyPath);

    expect(existsSync(dir)).toBe(true);
    plan.cleanup();
    expect(existsSync(dir)).toBe(false);
    expect(() => plan.cleanup()).not.toThrow();
  });

  it("只放行 allowUnsafeSshCommand", () => {
    const plan = buildGitAuthEnv({ kind: "ssh_key", privateKey: PRIVATE_KEY });
    cleanups.push(plan.cleanup);
    expect(plan.unsafe).toEqual({ allowUnsafeSshCommand: true });
  });
});

describe("assertUsablePrivateKey", () => {
  it("拒绝明显非法的私钥", () => {
    expect(() => assertUsablePrivateKey("not-a-key")).toThrow();
  });

  it("拒绝空私钥", () => {
    expect(() => assertUsablePrivateKey("   ")).toThrow();
  });
});

describe("stripSimpleGitDebug", () => {
  it("把 simple-git 从 DEBUG 中剥掉（它会打印含 Authorization 头的 spawn options）", () => {
    const env = { DEBUG: "simple-git,foo" } as NodeJS.ProcessEnv;
    expect(stripSimpleGitDebug(env)).toBe(true);
    expect(env.DEBUG).toBe("foo");
  });

  it("只剩 simple-git 时整个删掉 DEBUG", () => {
    const env = { DEBUG: "simple-git*" } as NodeJS.ProcessEnv;
    expect(stripSimpleGitDebug(env)).toBe(true);
    expect(env.DEBUG).toBeUndefined();
  });

  it("没命中就不动", () => {
    const env = { DEBUG: "foo,bar" } as NodeJS.ProcessEnv;
    expect(stripSimpleGitDebug(env)).toBe(false);
    expect(env.DEBUG).toBe("foo,bar");
  });

  it("没有 DEBUG 时安全返回", () => {
    expect(stripSimpleGitDebug({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("cleanupStaleGitAuthDirs", () => {
  it("能清理遗留的临时目录且不误伤其他目录", () => {
    const plan = buildGitAuthEnv({ kind: "ssh_key", privateKey: "-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----\n" });
    const dir = dirname(/-i '([^']+)'/.exec(plan.env.GIT_SSH_COMMAND!)![1]);
    expect(existsSync(dir)).toBe(true);
    expect(dirname(dir).endsWith("kg-git-") || dir.includes(GIT_AUTH_TMP_PREFIX)).toBe(true);

    const removed = cleanupStaleGitAuthDirs();
    expect(removed).toBeGreaterThan(0);
    expect(existsSync(dir)).toBe(false);
  });
});
