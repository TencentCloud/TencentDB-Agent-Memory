import { log } from "../report/log.js";

export const STREAM_IDLE_WARN_MS = 60_000;

export interface StreamIdleContext {
  spaceId?: string;
  traceId: string;
  /** 完整代理请求 ID。 */
  requestId: string;
  upstreamRequestId?: string;
  model: string;
  protocol: string;
  branch: string;
}

/**
 * 透明包装上游响应体：连续 60 秒没有读到任何字节时打一条 warn。
 *
 * 每个空闲区间只告警一次；后续恢复数据后重新计时。不会改变超时或取消策略，
 * 也不记录响应正文。
 */
export function withStreamIdleWarning(
  source: ReadableStream<Uint8Array>,
  context: StreamIdleContext,
  idleMs: number = STREAM_IDLE_WARN_MS,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const startedAt = performance.now();
  let lastChunkAt = startedAt;
  let pendingReadAt: number | null = null;
  let chunkCount = 0;
  let bytesReceived = 0;
  let idleWarned = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const armTimer = () => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (idleWarned) return;
      idleWarned = true;
      const now = performance.now();
      log.warn("stream.read_idle", {
        ...context,
        idleMs,
        elapsedMs: Math.round(now - startedAt),
        lastChunkAgoMs: Math.round(now - lastChunkAt),
        chunkCount,
        bytesReceived,
        readPending: pendingReadAt !== null,
        pendingReadMs: pendingReadAt === null ? 0 : Math.round(now - pendingReadAt),
      });
    }, idleMs);
    if (typeof timer.unref === "function") timer.unref();
  };

  armTimer();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      pendingReadAt = performance.now();
      try {
        const { done, value } = await reader.read();
        pendingReadAt = null;
        if (done) {
          clearTimer();
          reader.releaseLock();
          controller.close();
          return;
        }

        const now = performance.now();
        if (idleWarned) {
          log.info("stream.read_resumed", {
            ...context,
            elapsedMs: Math.round(now - startedAt),
            idleDurationMs: Math.round(now - lastChunkAt),
          });
        }
        idleWarned = false;
        lastChunkAt = now;
        chunkCount++;
        bytesReceived += value.byteLength;
        armTimer();
        controller.enqueue(value);
      } catch (err: unknown) {
        pendingReadAt = null;
        clearTimer();
        try {
          reader.releaseLock();
        } catch {
          // lock may already have been released by cancellation
        }
        controller.error(err);
      }
    },
    async cancel(reason) {
      clearTimer();
      pendingReadAt = null;
      try {
        await reader.cancel(reason);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // noop
        }
      }
    },
  });
}
