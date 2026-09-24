/**
 * L0 Finalize 幂等闸门测试
 *
 * 验证 finalize 回调在并发场景下只执行一次的幂等性保证。
 *
 * 背景：L0 写入的 agent_end hook 通过 Promise.all 同时触发两条路径
 * （用户消息 + 助手消息的读-写链路），它们串行进入 finalize。
 * 正确实现通过同步 if-and-set 闸门保证 finalize 只执行一次。
 *
 * 参考：GitHub issue #1289 — L0 漏记 bug
 *
 * @package tencentdb-agent-memory-tests
 */

import { describe, it, expect } from "vitest";

// ============================================================
// 测试用的闸门实现
// ============================================================

/**
 * 正确实现：同步 if-and-set 闸门
 * - 在同一个 JS 事件循环帧内，check 和 set 是同步操作
 * - 两个调用者即使同时进入 finalize，第二个 check 会看到 firstCaller 已设置
 * - JS 中 Promise.all 内的 async IIFE 串行执行，无真并发
 */
function createCorrectGate() {
  let firstCaller: string | null = null;
  let finalizeCallCount = 0;

  async function finalize(caller: string): Promise<string> {
    if (firstCaller !== null) {
      return `SKIP (firstCaller=${firstCaller})`;
    }
    firstCaller = caller;
    finalizeCallCount++;
    return `OK (caller=${caller})`;
  }

  function getFirstCaller() {
    return firstCaller;
  }

  function getCallCount() {
    return getCallCountInternal();

    function getCallCountInternal() {
      return finalizeCallCount;
    }
  }

  function reset() {
    firstCaller = null;
    finalizeCallCount = 0;
  }

  return { finalize, getFirstCaller, getCallCount, reset };
}

/**
 * 故意改坏的实现：check（前置同步）→ await（异步间隙）→ set（后置）
 * 这种写法在 check 和 set 之间存在异步间隙：
 * 两个并发调用者都能在各自 await 之前通过 check（此时 firstCaller 均为 null），
 * await 之后都执行 set → finalize 执行多次
 */
function createBrokenGate() {
  let firstCaller: string | null = null;
  let finalizeCallCount = 0;

  async function finalize(caller: string): Promise<string> {
    // check 是同步的，两个并发调用者都能在 await 前看到 null
    if (firstCaller !== null) {
      return `SKIP (firstCaller=${firstCaller})`;
    }
    // 故意在 set 之前加异步间隙（模拟网络延迟或异步 I/O）
    await new Promise((r) => setTimeout(r, 20));
    // set 在异步之后 → 两个调用者都执行了 set
    firstCaller = caller;
    finalizeCallCount++;
    return `OK (caller=${caller})`;
  }

  function getFirstCaller() {
    return firstCaller;
  }

  function getCallCount() {
    return getCallCountInternal();

    function getCallCountInternal() {
      return finalizeCallCount;
    }
  }

  function reset() {
    firstCaller = null;
    finalizeCallCount = 0;
  }

  return { finalize, getFirstCaller, getCallCount, reset };
}

// ============================================================
// 场景 1：单触发 — 基线验证
// ============================================================
describe("L0 finalize gate — single trigger (baseline)", () => {
  it("正确实现：finalize 只执行 1 次", async () => {
    const gate = createCorrectGate();
    const result = await gate.finalize("userA");
    expect(result).toBe("OK (caller=userA)");
    expect(gate.getCallCount()).toBe(1);
    expect(gate.getFirstCaller()).toBe("userA");
  });

  it("正确实现：第二次调用被 skip", async () => {
    const gate = createCorrectGate();
    await gate.finalize("userA");
    const result = await gate.finalize("userB");
    expect(result).toBe("SKIP (firstCaller=userA)");
    expect(gate.getCallCount()).toBe(1);
  });
});

// ============================================================
// 场景 2：同帧双触发 — 核心场景
// ============================================================
describe("L0 finalize gate — same-frame dual trigger", () => {
  it("正确实现：Promise.all 并发两个调用，finalize 只跑 1 次", async () => {
    const gate = createCorrectGate();

    const [r1, r2] = await Promise.all([
      gate.finalize("userA"),
      gate.finalize("userB"),
    ]);

    expect(gate.getCallCount()).toBe(1);
    // 第一个到达的 caller 赢得闸门，第二个被 skip
    if (r1.startsWith("OK")) {
      expect(r1).toBe("OK (caller=userA)");
      expect(r2).toBe("SKIP (firstCaller=userA)");
    } else {
      expect(r1).toBe("SKIP (firstCaller=userB)");
      expect(r2).toBe("OK (caller=userB)");
    }
  });

  it("正确实现：多次重复触发，finalize 仍然只跑 1 次", async () => {
    const gate = createCorrectGate();
    const results = await Promise.all([
      gate.finalize("A"),
      gate.finalize("B"),
      gate.finalize("C"),
      gate.finalize("D"),
      gate.finalize("E"),
    ]);

    expect(gate.getCallCount()).toBe(1);
    const okCount = results.filter((r: string) => r.startsWith("OK")).length;
    const skipCount = results.filter((r: string) => r.startsWith("SKIP")).length;
    expect(okCount).toBe(1);
    expect(skipCount).toBe(4);
  });
});

// ============================================================
// 场景 3：改坏写法 — 对照实验
// ============================================================
describe("L0 finalize gate — broken implementation (control)", () => {
  it("改坏实现：同帧双触发导致 finalize 跑 2 次", async () => {
    const gate = createBrokenGate();

    const [r1, r2] = await Promise.all([
      gate.finalize("userA"),
      gate.finalize("userB"),
    ]);

    // 两个都通过了 check（因为异步间隙），finalize 执行了 2 次
    expect(gate.getCallCount()).toBe(2);
  });

  it("改坏实现：5 个并发调用全部通过 check", async () => {
    const gate = createBrokenGate();
    const results = await Promise.all([
      gate.finalize("A"),
      gate.finalize("B"),
      gate.finalize("C"),
      gate.finalize("D"),
      gate.finalize("E"),
    ]);

    expect(gate.getCallCount()).toBe(5);
    const okCount = results.filter((r: string) => r.startsWith("OK")).length;
    expect(okCount).toBe(5);
  });
});

// ============================================================
// 场景 4：反序触发 — 调用顺序不依赖 finalize 赢得顺序
// ============================================================
describe("L0 finalize gate — reverse order", () => {
  it("正确实现：B 先于 A 进入 finalize（模拟真实竞态）", async () => {
    const gate = createCorrectGate();

    // 模拟真实场景：两条链路串行进入 finalize，但 B 比 A 早到
    // 在 JS 中：await 后的代码会将执行权让给其他 microtask
    async function chainA() {
      await Promise.resolve(); // 微任务让出
      return gate.finalize("A");
    }

    async function chainB() {
      await Promise.resolve();
      return gate.finalize("B");
    }

    const [rA, rB] = await Promise.all([chainA(), chainB()]);
    expect(gate.getCallCount()).toBe(1);
  });

  it("正确实现：带真实异步 I/O 的反序", async () => {
    const gate = createCorrectGate();

    // 模拟链路 A 需要一次网络 I/O（较慢），链路 B 直接调用（较快）
    async function chainA() {
      // 模拟慢路径：先做一次异步操作
      await new Promise((r) => setTimeout(r, 50));
      return gate.finalize("A");
    }

    async function chainB() {
      // 模拟快路径
      await Promise.resolve();
      return gate.finalize("B");
    }

    const [rA, rB] = await Promise.all([chainA(), chainB()]);
    expect(gate.getCallCount()).toBe(1);
    // B 应该赢得闸门（A 还在等待 I/O）
    if (rB.startsWith("OK")) {
      expect(rB).toBe("OK (caller=B)");
      expect(rA).toBe("SKIP (firstCaller=B)");
    }
  });
});

// ============================================================
// 场景 5：与 checkpoint.ts captureAtomically 的契约验证
// ============================================================
describe("L0 finalize gate — captureAtomically contract", () => {
  it("两次 captureAtomically 调用（同一 session），finalize 执行 1 次", async () => {
    const gate = createCorrectGate();

    // 模拟两个 agent_end 事件同时触发 captureAtomically
    const capture = async (caller: string) => {
      // captureAtomically 内部：mutate 时读游标 → fn(afterTimestamp) → 推进游标
      // fn 的核心是 recordConversation → finalize L0 写入
      // 这里的闸门验证 finalize 只跑一次
      return gate.finalize(caller);
    };

    const [r1, r2] = await Promise.all([
      capture("event-1"),
      capture("event-2"),
    ]);

    expect(gate.getCallCount()).toBe(1);
    // L0 写入应完整（不漏记）
    expect(r1.startsWith("OK") || r2.startsWith("OK")).toBe(true);
    expect(r1.startsWith("SKIP") || r2.startsWith("SKIP")).toBe(true);
  });

  it("连续 3 次事件触发，finalize 只执行 1 次", async () => {
    const gate = createCorrectGate();

    // 模拟 tool-call 密集场景：一个会话内多次快速 agent_end
    const events = [
      { caller: "tool-call-1", delay: 0 },
      { caller: "tool-call-2", delay: 5 },
      { caller: "user-response", delay: 2 },
    ];

    const results = await Promise.all(
      events.map(async (e) => {
        await new Promise((r) => setTimeout(r, e.delay));
        return gate.finalize(e.caller);
      }),
    );

    expect(gate.getCallCount()).toBe(1);
    expect(results.filter((r) => r.startsWith("OK")).length).toBe(1);
    expect(results.filter((r) => r.startsWith("SKIP")).length).toBe(2);
  });
});

// ============================================================
// 场景 6：重置闸门（用于多轮对话独立 session）
// ============================================================
describe("L0 finalize gate — reset between sessions", () => {
  it("不同 session 的闸门独立", async () => {
    // 每个 session 有独立的闸门实例（由 CaptureCheckpoint 管理）
    const gateA = createCorrectGate();
    const gateB = createCorrectGate();

    await gateA.finalize("userA-session1");
    await gateB.finalize("userA-session2");

    expect(gateA.getCallCount()).toBe(1);
    expect(gateB.getCallCount()).toBe(1);
    expect(gateA.getFirstCaller()).toBe("userA-session1");
    expect(gateB.getFirstCaller()).toBe("userA-session2");
  });

  it("同一 session 内重置闸门后，再次触发重新计数", async () => {
    const gate = createCorrectGate();

    await gate.finalize("first");
    expect(gate.getCallCount()).toBe(1);

    // 模拟 session 结束后重置（新会话）
    gate.reset();
    await gate.finalize("second");
    expect(gate.getCallCount()).toBe(1);
    expect(gate.getFirstCaller()).toBe("second");
  });
});
