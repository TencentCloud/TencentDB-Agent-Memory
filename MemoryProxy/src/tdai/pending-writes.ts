/**
 * pending-writes — 追踪 in-flight 的 L0 写入 + 提供 SIGTERM flush 钩子 + 重试。
 *
 * 背景：streaming 场景下 recordTdaiTurn 必须 fire-and-forget（不能阻塞 SSE
 * 关流，否则拖慢首字后收尾体感）。但 fire-and-forget 有两个丢包场景：
 *   1. pod rolling update 收到 SIGTERM 时 event loop 里还有 promise 未 flush
 *      → node 进程直接退出 → L0 丢
 *   2. tdai kernel 短暂 503 / 网络抖动 → 单次 POST 失败没重试 → L0 丢
 *
 * 本模块两条对策：
 *   - `trackWrite(promise)`：把在飞的 promise 注册到 pending set，settle 时移除。
 *     `flushPendingWrites(deadlineMs)` 等待所有 in-flight 全部结束或超时。
 *     index.ts SIGTERM handler 在 shutdown 前调一次。
 *   - `withL0Retry(fn)`：给单条写包一层最多 3 次的指数退避重试。挡内核瞬断。
 *
 * 不改变的：
 *   - 非流式路径仍然 await（本模块的 track 也对 await 生效，但没多余开销）。
 *   - `recordTdaiTurn(client, identity=null | userMessage=null)` 时 client 侧直接
 *     return，本模块不介入。
 *
 * 重复写风险：如果第一次 POST 已到达 tdai kernel 但客户端读 5xx 超时后重试，
 * kernel 可能收到两条同样内容的 L0（tdai `/v3/conversation/add` 目前没有
 * idempotency-key）。可接受：宁可重复也不要丢；且重试的两次 POST payload 完全
 * 一致，L1/L2/L3 蒸馏管线幂等（同一 hash 一条），观测上仅 L0 冗余。
 */

const pendingWrites = new Set<Promise<unknown>>();

/**
 * 注册一个 in-flight 写。返回同一个 promise 便于链式使用。
 * settle 时自动从 set 移除。
 *
 * 注意：`.finally` 会返回新 promise，如果原 p 被 reject 且新链无 catch，
 * Node 会报 UnhandledRejection（甚至根据 --unhandled-rejections=strict 直接
 * 让进程 exit）。用 catch(noop) 把 cleanup 链 swallow 掉；原 p 交由 caller
 * 自己 catch（handler 侧确实 .catch 了 pipe.error("TDAI_L0", ...)）。
 */
export function trackWrite<T>(p: Promise<T>): Promise<T> {
  pendingWrites.add(p);
  p.finally(() => pendingWrites.delete(p)).catch(() => { /* caller owns rejection */ });
  return p;
}

/** 当前 in-flight 写数量（观测/测试用）。 */
export function pendingWriteCount(): number {
  return pendingWrites.size;
}

/**
 * 等待所有 in-flight 写结束或 deadline 到期。
 * SIGTERM handler 调；超时后返回未完成数便于日志观测（不阻塞退出）。
 */
export async function flushPendingWrites(deadlineMs: number = 10_000): Promise<{
  drained: boolean;
  remaining: number;
}> {
  if (pendingWrites.size === 0) return { drained: true, remaining: 0 };
  const snapshot = [...pendingWrites];
  const settled = Promise.allSettled(snapshot);
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), deadlineMs));
  const outcome = await Promise.race([settled.then(() => "ok" as const), timeout]);
  return { drained: outcome === "ok", remaining: pendingWrites.size };
}

/**
 * 指数退避重试包装。用于 tdai kernel 瞬断场景。
 *
 * 默认参数：3 次总尝试，间隔 500ms → 1s → 2s（含 jitter）。
 * 总最长 ~3.5s，pod SIGTERM grace period 一般是 30s，flushPendingWrites
 * 默认 10s 兜底，够跑完 3 次重试。
 *
 * 只重试"值得重试"的错误（网络、5xx、408、429）；4xx 客户端错误直接抛。
 */
export async function withL0Retry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      const wait = baseMs * (2 ** i) + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * 简单判定：网络错、5xx、408/429 值得重试；其它（400/401/403/404/422）直接放弃。
 * TdaiClient 的错误目前是 `throw new Error(\`tdai POST ... HTTP <code>: <body>\`)`
 * 形式，用正则捞状态码。捞不到（网络断/timeout）默认 retry。
 */
function isRetryable(err: unknown): boolean {
  if (!err) return false;
  const metadata = err as { retryable?: unknown; status?: unknown };
  if (typeof metadata.retryable === "boolean") return metadata.retryable;
  if (typeof metadata.status === "number") {
    return metadata.status >= 500 || metadata.status === 408 || metadata.status === 429;
  }
  const msg = err instanceof Error ? err.message : String(err);
  // 网络类：AbortError / ENOTFOUND / ECONNRESET / ETIMEDOUT / fetch failed
  if (/abort|econnreset|enotfound|etimedout|fetch failed|network|timeout/i.test(msg)) return true;
  // HTTP 状态码类
  const m = msg.match(/HTTP (\d{3})/);
  if (!m) return true; // 无状态码信息 → 保守 retry
  const code = Number(m[1]);
  return code >= 500 || code === 408 || code === 429;
}
