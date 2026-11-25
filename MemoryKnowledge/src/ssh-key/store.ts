/**
 * SshKeyStore —— 每用户 SSH 密钥对的落盘实现。
 *
 * 目录布局（root 默认 `${KNOWLEDGE_DATA_DIR}/ssh-keys`，可用 KNOWLEDGE_SSH_KEY_DIR 覆盖）：
 *   <root>/<service_id>/
 *     ├── id_rsa_<safe>              0600  私钥
 *     ├── id_rsa_<safe>.pub          0644  公钥
 *     ├── id_rsa_<safe>.owner        0600  原始 username（碰撞判定用）
 *     └── known_hosts                0600  StrictHostKeyChecking=accept-new 落点
 *
 * 安全：
 *   - ssh-keygen 用 spawn + args 数组，无 shell、无用户输入拼接
 *   - 目录 0700 / 私钥 0600；响应与日志只出现 public_key，绝不出现私钥内容
 *   - 并发 ensure 用 in-flight Promise 去重，避免两个 ssh-keygen 写同一文件产生半截私钥
 *
 * 设计文档：MemoryPanel/docs/design/2026-10-10-codegraph-ssh-clone.md §2.3
 */

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../logger.js";
import {
  sanitizeUsername,
  collisionSuffix,
  ownerMatches,
  FALLBACK_USERNAME,
} from "./username.js";
import type { ISshKeyStore, SshKeyInfo } from "./types.js";

const log = createLogger("ssh-key-store");

export class SshKeygenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshKeygenError";
  }
}

export interface SshKeyStoreOptions {
  /** 密钥根目录（已由 config 解析出绝对路径）。 */
  rootDir: string;
  /** RSA 位数，默认 4096。 */
  bits?: number;
}

/** ssh-keygen 单次执行超时（正常 4096 位 < 1s；留足余量防 /dev/random 阻塞）。 */
const KEYGEN_TIMEOUT_MS = 30_000;

export class SshKeyStore implements ISshKeyStore {
  private readonly rootDir: string;
  private readonly bits: number;
  /** (serviceId, username) → in-flight ensure Promise，防并发重复生成。 */
  private readonly inFlight = new Map<string, Promise<SshKeyInfo>>();

  constructor(opts: SshKeyStoreOptions) {
    this.rootDir = opts.rootDir;
    this.bits = opts.bits ?? 4096;
  }

  async ensure(serviceId: string, username: string): Promise<SshKeyInfo> {
    const cacheKey = `${serviceId}::${username}`;
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const task = this.doEnsure(serviceId, username).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, task);
    return task;
  }

  get(serviceId: string, username: string): SshKeyInfo | null {
    // 只走“已存在”判定，绝不生成。与 ensure 内部的 readExisting 保持同一套命名规则。
    const base = this.resolveBaseName(serviceId, username);
    return this.readExisting(serviceId, base);
  }

  /**
   * 解析该用户私钥的基名（不含目录）。
   *
   * 规则（§2.3）：
   *   1. 首选 `id_rsa_<safe>`
   *   2. 若该基名已被**另一个** username 占用（.owner 不匹配）→ `id_rsa_<safe>_<sha256[:8]>`
   */
  private resolveBaseName(serviceId: string, username: string): string {
    const safe = sanitizeUsername(username);
    const preferred = `id_rsa_${safe}`;
    const ownerFile = this.pathFor(serviceId, `${preferred}.owner`);

    if (!existsSync(ownerFile)) return preferred;

    try {
      const ownerRaw = readFileSync(ownerFile, "utf8");
      if (ownerMatches(ownerRaw, username)) return preferred;
    } catch {
      // 读不了标记文件 → 保守退化，避免误用他人私钥
    }
    return `id_rsa_${safe}_${collisionSuffix(username)}`;
  }

  private dirFor(serviceId: string): string {
    return join(this.rootDir, serviceId);
  }

  private pathFor(serviceId: string, filename: string): string {
    return join(this.dirFor(serviceId), filename);
  }

  /** 读回已存在的密钥；任一文件缺失/不可读 → null（当作不存在）。 */
  private readExisting(serviceId: string, base: string): SshKeyInfo | null {
    const keyPath = this.pathFor(serviceId, base);
    const pubPath = this.pathFor(serviceId, `${base}.pub`);
    if (!existsSync(keyPath) || !existsSync(pubPath)) return null;
    try {
      const publicKey = readFileSync(pubPath, "utf8").trim();
      if (!publicKey) return null;
      return {
        keyPath,
        pubPath,
        knownHostsPath: this.pathFor(serviceId, "known_hosts"),
        publicKey,
        created: false,
      };
    } catch {
      return null;
    }
  }

  private async doEnsure(serviceId: string, username: string): Promise<SshKeyInfo> {
    const dir = this.dirFor(serviceId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdirSync 的 mode 在目录已存在时不生效，显式兜底收紧权限。
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* 非致命：某些挂载卷不支持 chmod */
    }

    const base = this.resolveBaseName(serviceId, username);
    const already = this.readExisting(serviceId, base);
    if (already) return already;

    const keyPath = this.pathFor(serviceId, base);
    const pubPath = this.pathFor(serviceId, `${base}.pub`);
    const ownerPath = this.pathFor(serviceId, `${base}.owner`);
    const knownHostsPath = this.pathFor(serviceId, "known_hosts");

    // 目标已存在但读回失败（半截文件）→ 清掉重来，避免 ssh-keygen 因文件已存在而拒绝。
    for (const p of [keyPath, pubPath]) {
      if (existsSync(p)) {
        try {
          rmSync(p, { force: true });
        } catch {
          /* 清不掉就让 ssh-keygen 报错，由上层转 SSH_KEYGEN_FAILED */
        }
      }
    }

    // 注释里放 username，方便用户在 Git 平台认出是哪台机器的 key。
    const comment = `tdai-codegraph:${username}`;
    await this.runKeygen(keyPath, comment);

    // 权限兜底：ssh-keygen 默认私钥 600，此处显式收紧，防 umask 影响。
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      /* ignore */
    }
    try {
      chmodSync(pubPath, 0o644);
    } catch {
      /* ignore */
    }

    // owner 标记：下次 resolveBaseName 判定归属用。
    try {
      writeFileSync(ownerPath, username, { mode: 0o600 });
      chmodSync(ownerPath, 0o600);
    } catch (err) {
      // 写不了标记不影响本次使用，但下次可能误判归属 → 记 warn。
      log.warn("ssh-key owner marker write failed", {
        serviceId,
        username,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // known_hosts 预建（ssh 在 accept-new 下会自动追加，但需要文件可写）。
    if (!existsSync(knownHostsPath)) {
      try {
        writeFileSync(knownHostsPath, "", { mode: 0o600 });
      } catch {
        /* ignore */
      }
    }
    try {
      chmodSync(knownHostsPath, 0o600);
    } catch {
      /* ignore */
    }

    const publicKey = readFileSync(pubPath, "utf8").trim();
    log.info("ssh-key generated", { serviceId, username, base });

    return { keyPath, pubPath, knownHostsPath, publicKey, created: true };
  }

  /**
   * 执行 ssh-keygen。args 数组、无 shell —— username 只作为 -C 参数值传入，
   * 不经任何 shell 解析，从原理上消除命令注入。
   */
  private runKeygen(keyPath: string, comment: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        "-t", "rsa",
        "-b", String(this.bits),
        "-m", "PEM",
        "-N", "",
        "-C", comment,
        "-f", keyPath,
        "-q",
      ];
      const child = spawn("ssh-keygen", args, { stdio: ["ignore", "pipe", "pipe"] });

      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new SshKeygenError("ssh-keygen timed out"));
      }, KEYGEN_TIMEOUT_MS);

      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === "ENOENT") {
          reject(
            new SshKeygenError(
              "ssh-keygen not found in container (image must install openssh-client)",
            ),
          );
          return;
        }
        reject(new SshKeygenError(`ssh-keygen failed to start: ${err.message}`));
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
          return;
        }
        // stderr 可能含路径但绝不含私钥内容；截断防刷屏。
        const brief = stderr.split("\n").find((l) => l.trim())?.trim() ?? "";
        reject(new SshKeygenError(`ssh-keygen exited ${code}: ${brief.slice(0, 300)}`));
      });
    });
  }
}

/** 供测试/诊断用：默认用户名（sanitize 兜底值）。 */
export { FALLBACK_USERNAME };
