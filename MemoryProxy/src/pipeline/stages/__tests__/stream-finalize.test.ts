/**
 * stream-finalize helpers — createOnceFinalizer。
 *
 * 回归背景（2026-10-26 实抓，issue 待提）：
 *   OpenCode 等 SSE 客户端读到 `data: [DONE]` 就立即断开连接。当客户端断开
 *   赢得与上游 FIN 的竞态时，运行时 cancel 掉 Response 流的 TransformStream，
 *   `flush()` 永远不会执行 → 该轮 L0 写入 / skill 触发 / credit 上报全部静默
 *   丢失（write-l0 从不打印，hub 记忆为空）。openai-chat 的流式 tap 只有
 *   flush 没有 cancel，而 anthropic 路径用独立 reader 循环天然免疫。
 *
 *   修法：finalize 逻辑提到幂等 wrapper 里，flush 与 cancel 都调用它；
 *   once 旗标保证「abort 后上游关闭」不会双触发。
 */

import { describe, expect, it, vi } from "vitest";
import { createOnceFinalizer } from "../stream-finalize.js";

describe("createOnceFinalizer", () => {
  it("只执行一次（重复调用 / flush+cancel 双路径都安全）", async () => {
    const finalize = vi.fn().mockResolvedValue(undefined);
    const once = createOnceFinalizer(finalize, () => {});
    await once();
    await once();
    await once();
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("错误交给 onError 且不向上抛（不能让 flush/cancel 抛二次异常）", async () => {
    const boom = new Error("finalize boom");
    const finalize = vi.fn().mockRejectedValue(boom);
    const onError = vi.fn();
    const once = createOnceFinalizer(finalize, onError);
    await expect(once()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("失败后再次调用不重试（once 语义：成功前标记已置位）", async () => {
    const finalize = vi.fn().mockRejectedValue(new Error("x"));
    const once = createOnceFinalizer(finalize, () => {});
    await once();
    await once();
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("并发调用只跑一次（flush 与 cancel 同时触发）", async () => {
    let resolveFn: () => void = () => {};
    const finalize = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveFn = resolve; }),
    );
    const once = createOnceFinalizer(finalize, () => {});
    const p1 = once();
    const p2 = once();
    resolveFn();
    await Promise.all([p1, p2]);
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});
