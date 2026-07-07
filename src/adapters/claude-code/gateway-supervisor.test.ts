import { describe, it, expect } from "vitest";
import { GatewaySupervisor } from "./gateway-supervisor";
import { GatewayLifecycleManager } from "../../sdk/lifecycle";
import type { TdaiClient } from "../../sdk/client";

/**
 * Step 3.1 之后，GatewaySupervisor 仅是 GatewayLifecycleManager 的别名。
 * 逻辑测试已迁至 src/sdk/lifecycle.test.ts；本文件只验证别名契约：
 *   1. 两个名字指向同一个类
 *   2. 通过别名构造 / 调用仍正常工作
 */
function makeFakeClient(healthImpl: () => Promise<unknown>) {
  const client = { health: async () => healthImpl() } as unknown as TdaiClient;
  return client;
}

const noSleep = async () => {};

describe("GatewaySupervisor（别名契约）", () => {
  it("GatewaySupervisor === GatewayLifecycleManager（同一类）", () => {
    expect(GatewaySupervisor).toBe(GatewayLifecycleManager);
  });

  it("通过别名构造并调用 isRunning 仍正常工作", async () => {
    const client = makeFakeClient(() => Promise.resolve({ status: "ok" }));
    const s = new GatewaySupervisor({ client, healthRetries: 1, sleep: noSleep });
    expect(await s.isRunning()).toBe(true);
    expect(s.isCircuitOpen()).toBe(false);
  });
});
