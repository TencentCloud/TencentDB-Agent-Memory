/**
 * Git 认证注入 —— 把凭证安全地交给 git 子进程。
 *
 * 核心约束（三条都踩过坑，改动前请先读完）：
 *
 * 1. **凭证不进 URL、不进 argv、不进 `.git/config`。**
 *    历史写法 `https://user:token@host/repo.git` 会把 token 落到 `.git/config`
 *    的 remote.origin.url、git 的 stderr、以及本项目所有回显错误信息的地方。
 *    这里改用 git 官方的 `GIT_CONFIG_COUNT/KEY_n/VALUE_n` 机制（git ≥ 2.31）经
 *    **子进程环境变量**注入 `http.extraHeader`，三个位置都不会残留。
 *
 * 2. **simple-git ≥ 3.36 默认会拦下这些机制。**
 *    它在实例化时无条件挂载 `blockUnsafeOperationsPlugin`，未显式开启
 *    `unsafe.allowUnsafe*` 时直接抛 `GitPluginError`。所以本模块除了产出 env，
 *    还要产出「需要放行哪些 unsafe 类别」—— 只放行本次真正用到的，不要图省事全开。
 *
 * 3. **环境变量必须走白名单，不能 `{...process.env}`。**
 *    盲展开会把用户 shell 里的 `GIT_PAGER`/`GIT_TRACE*`/`GIT_ASKPASS`/
 *    `GIT_SSH_COMMAND` 一起继承下来：既可能触发上面那个护栏，也可能让
 *    `GIT_TRACE_CURL=1` 把 `Authorization` 头打进 stderr。
 *
 * SSH 路径另注：`GIT_SSH_COMMAND` 是**由 shell 解释**的字符串，因此其中的路径
 * 一律 shell-quote，且 host 绝不参与拼接（known_hosts 用固定单一路径）。
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type GitAuthKind = "https_token" | "ssh_key";

/** 解密后的凭证材料。只允许在 build 期间短暂存在于内存。 */
export interface GitAuthMaterial {
  kind: GitAuthKind;
  /** HTTPS 用户名；缺省 `oauth2`。GitHub App installation token 需传 `x-access-token`。 */
  username?: string;
  /** HTTPS token / password。 */
  token?: string;
  /** SSH 私钥（PEM / OpenSSH 格式，不支持带 passphrase）。 */
  privateKey?: string;
}

/** 需要放行的 simple-git `unsafe` 类别。 */
export interface GitUnsafeFlags {
  allowUnsafeConfigEnvCount?: boolean;
  allowUnsafeCredentialHelper?: boolean;
  allowUnsafeSshCommand?: boolean;
}

export interface GitAuthEnvOptions {
  /**
   * known_hosts 文件绝对路径。**必须是固定单一路径**，不要按 host 拼路径 ——
   * 该值会进入 `GIT_SSH_COMMAND`，按 host 拼接等于把用户输入接进 shell。
   * 缺省时退化为每次 build 的临时目录（TOFU 无持久化）。
   */
  knownHostsPath?: string;
  /** true = `StrictHostKeyChecking=yes`；false（默认）= `accept-new`（TOFU）。 */
  strictHostKey?: boolean;
  /** 非致命提示出口（如 Windows 上 chmod 无效）。 */
  onWarn?: (message: string) => void;
}

export interface GitAuthPlan {
  /** 传给 `simpleGit(...).env(plan.env)` 的环境变量。 */
  env: NodeJS.ProcessEnv;
  /** 传给 `simpleGit({ unsafe: plan.unsafe })`，只含本次必需的放行项。 */
  unsafe: GitUnsafeFlags;
  /** 本次用到的明文凭证，供日志/错误信息脱敏。 */
  secrets: string[];
  /** 幂等清理（删除临时私钥目录）。必须放在 `finally` 里调用。 */
  cleanup: () => void;
}

export const DEFAULT_HTTPS_USERNAME = "oauth2";

/** 临时私钥目录前缀，同时用于启动时的残留清扫。 */
export const GIT_AUTH_TMP_PREFIX = "kg-git-";

/**
 * 允许继承给 git 子进程的环境变量白名单。
 * 刻意不包含任何 `GIT_*`：git 的行为只由本模块显式注入的变量决定。
 */
const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  // Windows
  "SYSTEMROOT",
  "PATHEXT",
  "ComSpec",
  "APPDATA",
  "USERPROFILE",
] as const;

function baseEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value) out[key] = value;
  }
  return out;
}

/** POSIX shell 单引号转义：' → '\'' 。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`git credential is missing ${field}`);
  }
  return value;
}

/**
 * 构造一次 git 操作的认证环境。调用方必须保证 `cleanup()` 被执行。
 */
export function buildGitAuthEnv(material: GitAuthMaterial, opts: GitAuthEnvOptions = {}): GitAuthPlan {
  if (material.kind === "https_token") {
    const token = requireNonEmpty(material.token, "token");
    const username = material.username?.trim() || DEFAULT_HTTPS_USERNAME;
    const basic = Buffer.from(`${username}:${token}`, "utf8").toString("base64");

    return {
      env: {
        ...baseEnv(),
        // 认证失败时立刻报错，绝不挂起等待交互输入。
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
        // 空值 = 清空 helper 链。否则 macOS osxkeychain / git-credential-manager
        // 会接管认证并把 token 缓存进系统钥匙串。
        GIT_CONFIG_KEY_1: "credential.helper",
        GIT_CONFIG_VALUE_1: "",
      },
      unsafe: { allowUnsafeConfigEnvCount: true, allowUnsafeCredentialHelper: true },
      secrets: [token],
      cleanup: () => {},
    };
  }

  if (material.kind === "ssh_key") {
    const privateKey = requireNonEmpty(material.privateKey, "privateKey");

    if (process.platform === "win32") {
      opts.onWarn?.(
        "SSH git credential on Windows: file permissions (0600) are not enforced by chmod; " +
          "prefer an HTTPS token credential on this platform.",
      );
    }

    const dir = mkdtempSync(join(tmpdir(), GIT_AUTH_TMP_PREFIX));
    // mkdtemp 在 POSIX 上已是 0700，显式再设一次以防 umask 差异。
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* Windows / 只读挂载：忽略，不影响主流程 */
    }

    const keyPath = join(dir, "id_key");
    // ssh 会拒绝权限过宽的私钥（UNPROTECTED PRIVATE KEY FILE），必须是 0600。
    writeFileSync(keyPath, normalizePrivateKey(privateKey), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      /* 同上 */
    }

    const knownHostsPath = opts.knownHostsPath ?? join(dir, "known_hosts");
    if (opts.knownHostsPath) {
      // 持久 known_hosts：ssh 首次连接会写入，父目录必须存在且可写。
      try {
        mkdirSync(dirname(opts.knownHostsPath), { recursive: true, mode: 0o700 });
        if (!existsSync(opts.knownHostsPath)) {
          writeFileSync(opts.knownHostsPath, "", { encoding: "utf8", mode: 0o600 });
        }
      } catch (err) {
        opts.onWarn?.(`cannot prepare known_hosts at ${opts.knownHostsPath}: ${String(err)}`);
      }
    }

    const strict = opts.strictHostKey ? "yes" : "accept-new";
    const sshCommand = [
      "ssh",
      "-i",
      shellQuote(keyPath),
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentityAgent=none",
      "-o",
      `StrictHostKeyChecking=${strict}`,
      "-o",
      `UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
    ].join(" ");

    let cleaned = false;
    return {
      env: {
        ...baseEnv(),
        // GIT_TERMINAL_PROMPT 管不到 ssh —— 必须靠 BatchMode=yes 才能让
        // 认证失败立刻返回而不是挂在密码提示上。
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: sshCommand,
      },
      unsafe: { allowUnsafeSshCommand: true },
      secrets: [privateKey],
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* 尽力而为 */
        }
      },
    };
  }

  throw new Error(`unsupported git credential kind: ${String((material as { kind?: unknown }).kind)}`);
}

/** 统一私钥文本形态：去 BOM、统一换行、补齐末尾换行（部分 ssh 版本要求）。 */
function normalizePrivateKey(privateKey: string): string {
  const normalized = privateKey.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trimEnd();
  return `${normalized}\n`;
}

/**
 * 校验私钥可用且**未加密**。
 *
 * 不能靠扫 PEM 文本判断是否带 passphrase —— OpenSSH 新格式把加密标志编码在
 * base64 内容里，文本层看不到 `Proc-Type`/`bcrypt`，会导致加密私钥被放行、
 * 然后在 build 阶段静默失败。这里改用 `ssh-keygen -y -P ''` 实际解一次：
 *   - 退出码非 0 → 加密或非法
 *   - ssh-keygen 不存在（如精简镜像）→ 退化为结构检查，避免误伤
 *
 * @throws Error 带用户可读原因（路由层转 422）
 */
export function assertUsablePrivateKey(privateKey: string): void {
  const dir = mkdtempSync(join(tmpdir(), GIT_AUTH_TMP_PREFIX));
  const keyPath = join(dir, "probe_key");
  try {
    writeFileSync(keyPath, normalizePrivateKey(privateKey), { encoding: "utf8", mode: 0o600 });

    try {
      execFileSync("ssh-keygen", ["-y", "-f", keyPath, "-P", ""], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      return;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
      if (e.code === "ENOENT") {
        // 环境里没有 ssh-keygen：只能做结构校验（不阻断合法部署）。
        if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
          throw new Error("invalid SSH private key: missing PEM header");
        }
        return;
      }

      const stderr = String(e.stderr ?? e.message ?? "");
      if (/passphrase|encrypted/i.test(stderr)) {
        throw new Error(
          "SSH private keys protected by a passphrase are not supported: provide an unencrypted key",
        );
      }
      throw new Error(`invalid SSH private key: ${stderr.trim().split("\n")[0] || "ssh-keygen rejected it"}`);
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  }
}

/**
 * 从 `DEBUG` 里剥掉 `simple-git`。
 *
 * simple-git 的 debug 输出会打印 spawn options，而 spawn options 里含我们注入的
 * `GIT_CONFIG_VALUE_0`（即 `Authorization: Basic ...`）。也就是说一旦有人为了排查
 * 问题开了 `DEBUG=simple-git`，凭证就会静默写进日志。这里主动剥离而不是只在
 * 文档里提醒。
 *
 * @returns 是否发生了修改
 */
export function stripSimpleGitDebug(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DEBUG;
  if (!raw) return false;

  const parts = raw.split(/[\s,]+/).filter(Boolean);
  const kept = parts.filter((part) => !part.toLowerCase().startsWith("simple-git"));
  if (kept.length === parts.length) return false;

  if (kept.length === 0) {
    delete env.DEBUG;
  } else {
    env.DEBUG = kept.join(",");
  }
  return true;
}

/**
 * 清扫历史遗留的临时私钥目录。
 * 正常路径由 `cleanup()` 兜住；进程被 SIGKILL 时会残留，故在启动时补一刀。
 */
export function cleanupStaleGitAuthDirs(): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.startsWith(GIT_AUTH_TMP_PREFIX)) continue;
    try {
      rmSync(join(tmpdir(), entry), { recursive: true, force: true });
      removed += 1;
    } catch {
      /* 被其他进程占用等情况，忽略 */
    }
  }

  return removed;
}
