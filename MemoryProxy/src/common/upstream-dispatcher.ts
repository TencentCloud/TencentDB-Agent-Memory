/**
 * 进程级 HTTP 客户端超时：放宽 undici 的默认 300s。
 *
 * 为什么要改：Node 内置 fetch 底层是 undici，它的 `bodyTimeout`（两次收到响应体字节
 * 之间的最大间隔）和 `headersTimeout`（等响应头）默认都是 300s，而且不受 fetch 的
 * `signal` 控制。部分上游网关会把超长的工具参数攒完再一次性发出，期间连 ping 都不发，
 * 一停就是几分钟——超过 300s 时 undici 直接掐断，报 `TypeError: terminated`
 * （cause 是 `BodyTimeoutError`），整轮输出作废、客户端重试后大概率再次撞上。
 *
 * 放宽后，整次转发仍由 `server.forwardTimeoutMs`（AbortSignal，默认 1h）兜底。
 *
 * 用 npm 的 undici（与 Node 22 内置版本同为 v6）设置全局 dispatcher：内置 fetch
 * 读的是同一个全局 symbol，所以所有 fetch 调用都会用上；其它出站请求各自带
 * `AbortSignal.timeout`，不受放宽影响。
 */

import { Agent, setGlobalDispatcher } from "undici";
import { log } from "../report/log.js";

/** 30 分钟：与 Claude Code 字节级看门狗的上限一致，再长客户端也等不到。 */
export const DEFAULT_UPSTREAM_BODY_TIMEOUT_MS = 1_800_000;
/** 10 分钟：与 Claude Code `API_TIMEOUT_MS` 默认值一致。 */
export const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = 600_000;

export interface UpstreamDispatcherOptions {
  /** 两次收到响应体字节之间的最大间隔（毫秒）。0 = 不限。 */
  bodyTimeoutMs?: number;
  /** 等待响应头的最大时长（毫秒）。0 = 不限。 */
  headersTimeoutMs?: number;
}

export interface ResolvedUpstreamTimeouts {
  bodyTimeoutMs: number;
  headersTimeoutMs: number;
}

function normalize(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  log.warn("upstream_dispatcher.invalid_timeout", { field, value: String(value), fallback });
  return fallback;
}

export function resolveUpstreamTimeouts(opts: UpstreamDispatcherOptions = {}): ResolvedUpstreamTimeouts {
  return {
    bodyTimeoutMs: normalize(opts.bodyTimeoutMs, DEFAULT_UPSTREAM_BODY_TIMEOUT_MS, "upstreamBodyTimeoutMs"),
    headersTimeoutMs: normalize(
      opts.headersTimeoutMs,
      DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS,
      "upstreamHeadersTimeoutMs",
    ),
  };
}

/** 启动时调用一次。失败只告警，继续用 undici 默认值。 */
export function installUpstreamDispatcher(opts: UpstreamDispatcherOptions = {}): ResolvedUpstreamTimeouts | null {
  const timeouts = resolveUpstreamTimeouts(opts);
  try {
    setGlobalDispatcher(new Agent({
      bodyTimeout: timeouts.bodyTimeoutMs,
      headersTimeout: timeouts.headersTimeoutMs,
    }));
    log.info("upstream_dispatcher.installed", { ...timeouts });
    return timeouts;
  } catch (err: unknown) {
    log.error("upstream_dispatcher.install_failed", {
      error: err instanceof Error ? err.message : String(err),
      note: "falling back to undici defaults (300s body / 300s headers)",
    });
    return null;
  }
}
