/**
 * CosStorage —— ProxyStorage 的对象存储实现（COS / S3-compatible）。
 *
 * 定位：生产多实例首选。
 *
 * 依赖注入：不直接 `import COS from "cos-nodejs-sdk-v5"`，而是接一个最小
 * `CosLikeBackend` 接口（PUT / GET / HEAD / DELETE / LIST），由 factory 层
 * 用真实 SDK 实例注入。这样单元测试可以用 mock backend 全流程验证 CosStorage
 * 逻辑，不打真桶；生产环境注入的是 openclaw 插件的 SharedCosClient wrapper。
 *
 * 语义要点：
 *   - putIfAbsent 走 COS `If-None-Match: "*"` header —— 存在返回 412
 *   - TTL 由桶 lifecycle rule 兜底（按 lastModified）
 *   - 凭据 403 / 重试逻辑由底层 backend 负责，不在这层处理
 */
import type { ProxyStorage } from "./proxy-storage.js";

/**
 * CosLikeBackend 契约 —— **定义在 cos-types.ts，这里 re-export 保持向后兼容**。
 *
 * 生产实现：cost-guard submodule 里的 CosStorageBackendMultiSpace（走
 * `await import("@context-proxy/cost-guard")`）。测试：用 in-memory mock
 * （见 cos-storage.test.ts）。
 *
 * 2026-07-13 抽 submodule 后新增 cos-types.ts 承载 CosLikeBackend +
 * KernelStsCosOptions；本文件只 re-export，签名不变，避免破坏老 caller
 * `import { CosLikeBackend } from "./cos-storage.js"`。
 */
export type { CosLikeBackend } from "./cos-types.js";
import type { CosLikeBackend } from "./cos-types.js";
import { log } from "../report/log.js";

// ── COS 操作日志（本层是主仓对 COS 链路的唯一收口点）────────────────────────
//
// 现状：CosStorage → cost-guard → COS SDK 三层全无失败/耗时日志，故障期读失败
// 被上层静默吞掉、完全不可见。这里补两个事件：
//   - `cos.op_failed`：COS 操作抛错（putIfAbsent 的 412 是业务语义，不算失败）
//   - `cos.slow`：单次操作 > SLOW_MS
// 节流：按维度（op:err_code / slow:op）30s 内最多一条 —— 首条立即打，窗口内
// 重复失败不再打，窗口过后再打。既防故障期刷屏，又让日志可计数（配合
// `> 5/15min` 告警阈值）并可据日志密度判断故障是否持续。
// 沿用 context-injector 的 warnOnce（Set + 容量上限）惯例。

type CosOp = "get" | "put" | "head" | "del" | "del_item" | "list";

/** 慢操作阈值（毫秒）。 */
const SLOW_MS = 2_000;
/** 失败/慢日志节流窗口（毫秒）。 */
const LOG_THROTTLE_MS = 30_000;
/** 节流表容量上限，防 err_code 维度无限膨胀（超限整体清空，最坏多打一条）。 */
const LOG_THROTTLE_CAP = 1_000;

/** 节流维度 → 上一次打日志的毫秒时间戳。模块级共享（节流是全局语义）。 */
const lastLogAt = new Map<string, number>();

interface CosErrorLike {
  name?: string;
  code?: string | number;
  statusCode?: number;
  message?: string;
}

function throttleLog(dimKey: string, emit: () => void): void {
  const now = Date.now();
  const last = lastLogAt.get(dimKey);
  if (last !== undefined && now - last < LOG_THROTTLE_MS) return;
  if (lastLogAt.size >= LOG_THROTTLE_CAP) lastLogAt.clear();
  lastLogAt.set(dimKey, now);
  emit();
}

/** 从 `{ttl|nottl}/{spaceId}/...` 提取 spaceId；布局不符返回 undefined。 */
function spaceIdOf(keyOrPrefix: string): string | undefined {
  const parts = keyOrPrefix.split("/");
  return parts.length >= 2 && parts[1] ? parts[1] : undefined;
}

function errFields(err: unknown): { errName: string; errCode: string | number | undefined } {
  const e = (err ?? {}) as CosErrorLike;
  return {
    errName: e.name ?? String(err).slice(0, 100),
    errCode: e.statusCode ?? e.code,
  };
}

function logOpFailed(op: CosOp, keyOrPrefix: string, err: unknown, durMs?: number): void {
  const { errName, errCode } = errFields(err);
  throttleLog(`${op}:${errCode ?? errName}`, () => {
    const spaceId = spaceIdOf(keyOrPrefix);
    log.warn("【P1】cos.op_failed", {
      op,
      ...(durMs !== undefined ? { dur_ms: durMs } : {}),
      err_name: errName,
      ...(errCode !== undefined ? { err_code: errCode } : {}),
      ...(spaceId ? { spaceId } : {}),
    });
  });
}

function logOpSlow(op: CosOp, keyOrPrefix: string, durMs: number): void {
  throttleLog(`slow:${op}`, () => {
    const spaceId = spaceIdOf(keyOrPrefix);
    log.warn("【P1】cos.slow", {
      op,
      dur_ms: durMs,
      ...(spaceId ? { spaceId } : {}),
    });
  });
}

/**
 * 包一个 COS 后端操作：计时；失败打 `cos.op_failed`、超阈值打 `cos.slow`；
 * 错误原样抛出（`isExpectedErr` 命中的错误不记日志，供调用方自行处理，
 * 如 putIfAbsent 的 412）。绝不吞错。
 */
async function withCosLog<T>(
  op: CosOp,
  keyOrPrefix: string,
  fn: () => Promise<T>,
  isExpectedErr?: (err: unknown) => boolean,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    const durMs = Date.now() - started;
    if (durMs > SLOW_MS) logOpSlow(op, keyOrPrefix, durMs);
    return result;
  } catch (err) {
    if (isExpectedErr?.(err)) throw err;
    logOpFailed(op, keyOrPrefix, err, Date.now() - started);
    throw err;
  }
}

export class CosStorage implements ProxyStorage {
  readonly type = "cos" as const;

  constructor(private readonly backend: CosLikeBackend) {}

  async putText(key: string, value: string): Promise<void> {
    await withCosLog("put", key, () => this.backend.putObject(key, Buffer.from(value, "utf-8")));
  }

  async putJSON(key: string, value: unknown): Promise<void> {
    return this.putText(key, JSON.stringify(value));
  }

  async putTextIfAbsent(key: string, value: string): Promise<boolean> {
    try {
      await withCosLog(
        "put",
        key,
        () => this.backend.putObject(key, Buffer.from(value, "utf-8"), { "If-None-Match": "*" }),
        (err) => (err as { statusCode?: number }).statusCode === 412,
      );
      return true;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 412) return false; // Preconditions failed = key existed
      throw err;
    }
  }

  async putJSONIfAbsent(key: string, value: unknown): Promise<boolean> {
    return this.putTextIfAbsent(key, JSON.stringify(value));
  }

  async getText(key: string): Promise<string | null> {
    const buf = await withCosLog("get", key, () => this.backend.getObject(key));
    if (!buf) return null;
    return buf.toString("utf-8");
  }

  async getJSON<T>(key: string): Promise<T | null> {
    const raw = await this.getText(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    return withCosLog("head", key, () => this.backend.headObject(key));
  }

  async del(key: string): Promise<void> {
    await withCosLog("del", key, () => this.backend.deleteObject(key));
  }

  async delPrefix(prefix: string): Promise<number> {
    const keys = await withCosLog("list", prefix, () => this.backend.listKeys(prefix));
    let n = 0;
    for (const k of keys) {
      try {
        await this.backend.deleteObject(k);
      } catch (err) {
        // best-effort：单条删除失败不中断、仍计数；补一条失败日志（节流）
        logOpFailed("del_item", k, err);
      }
      n++;
    }
    return n;
  }

  async listNames(prefix: string): Promise<string[]> {
    const keys = await withCosLog("list", prefix, () => this.backend.listKeys(prefix));
    return keys.map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k));
  }
}
