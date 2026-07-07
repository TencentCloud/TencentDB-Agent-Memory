import { describe, it, expect } from "vitest";
import { GatewayLifecycleManager } from "./lifecycle";
import type { TdaiClient } from "./client";

/**
 * 构造一个只实现 health() 的假 TdaiClient，并暴露调用计数。
 * lifecycle manager 仅用 health()，其余方法无需实现。
 */
function makeFakeClient(healthImpl: () => Promise<unknown>) {
  let calls = 0;
  const client = {
    health: async () => {
      calls++;
      return healthImpl();
    },
  } as unknown as TdaiClient;
  return { client, healthCalls: () => calls };
}

const noSleep = async () => {};

describe("GatewayLifecycleManager", () => {
  // ─── 基本探测 ─────────────────────────────────────────────────────────────

  it("health 成功（status=ok）→ isRunning true，熔断未开", async () => {
    const { client } = makeFakeClient(() => Promise.resolve({ status: "ok" }));
    const s = new GatewayLifecycleManager({ client, healthRetries: 1, sleep: noSleep });
    expect(await s.isRunning()).toBe(true);
    expect(s.isCircuitOpen()).toBe(false);
  });

  it("health degraded → isRunning true（可达即存活，degraded 不计失败）", async () => {
    const { client } = makeFakeClient(() => Promise.resolve({ status: "degraded" }));
    const s = new GatewayLifecycleManager({ client, healthRetries: 1, sleep: noSleep });
    expect(await s.isRunning()).toBe(true);
    expect(s.isCircuitOpen()).toBe(false);
  });

  it("health 首次失败、重试后成功 → isRunning true", async () => {
    let n = 0;
    const { client } = makeFakeClient(() => {
      n++;
      return n < 2
        ? Promise.reject(new Error("timeout"))
        : Promise.resolve({ status: "ok" });
    });
    const s = new GatewayLifecycleManager({
      client,
      healthRetries: 3,
      retryDelayMs: 0,
      sleep: noSleep,
    });
    expect(await s.isRunning()).toBe(true);
  });

  it("health 持续失败（超时）→ isRunning false，重试 healthRetries 次", async () => {
    const { client, healthCalls } = makeFakeClient(() =>
      Promise.reject(new Error("timeout")),
    );
    const s = new GatewayLifecycleManager({
      client,
      failureThreshold: 10, // 暂不触发熔断，只看重试次数
      healthRetries: 3,
      retryDelayMs: 0,
      sleep: noSleep,
    });
    expect(await s.isRunning()).toBe(false);
    expect(healthCalls()).toBe(3);
  });

  // ─── 熔断器 ───────────────────────────────────────────────────────────────

  it("连续失败达阈值 → 熔断开启，后续调用不发 health 请求", async () => {
    const { client, healthCalls } = makeFakeClient(() =>
      Promise.reject(new Error("timeout")),
    );
    const s = new GatewayLifecycleManager({
      client,
      failureThreshold: 3,
      healthRetries: 1,
      sleep: noSleep,
    });
    expect(await s.isRunning()).toBe(false); // 失败 1
    expect(await s.isRunning()).toBe(false); // 失败 2
    expect(await s.isRunning()).toBe(false); // 失败 3 → 熔断开启
    expect(s.isCircuitOpen()).toBe(true);

    // 第 4 次：熔断开启，直接返回 false，不发请求
    const callsBefore = healthCalls();
    expect(await s.isRunning()).toBe(false);
    expect(healthCalls()).toBe(callsBefore);
  });

  it("熔断冷却结束后半开探测成功 → 关闭熔断，失败计数归零", async () => {
    let failing = true;
    const { client } = makeFakeClient(() =>
      failing
        ? Promise.reject(new Error("timeout"))
        : Promise.resolve({ status: "ok" }),
    );
    let t = 1000;
    const s = new GatewayLifecycleManager({
      client,
      failureThreshold: 2,
      cooldownMs: 5000,
      healthRetries: 1,
      sleep: noSleep,
      now: () => t,
    });
    expect(await s.isRunning()).toBe(false); // 失败 1
    expect(await s.isRunning()).toBe(false); // 失败 2 → 熔断，until=6000
    expect(s.isCircuitOpen()).toBe(true);

    // 推进时间越过冷却期，转为半开
    t = 7000;
    failing = false;
    expect(await s.isRunning()).toBe(true); // 半开探测成功
    expect(s.isCircuitOpen()).toBe(false);

    // 失败计数已归零：再失败 1 次不应立即重开熔断
    failing = true;
    expect(await s.isRunning()).toBe(false);
    expect(s.isCircuitOpen()).toBe(false); // 仅 1 次失败，未达阈值 2
  });

  it("熔断冷却结束后半开探测失败 → 重新熔断", async () => {
    const { client } = makeFakeClient(() =>
      Promise.reject(new Error("timeout")),
    );
    let t = 1000;
    const s = new GatewayLifecycleManager({
      client,
      failureThreshold: 2,
      cooldownMs: 5000,
      healthRetries: 1,
      sleep: noSleep,
      now: () => t,
    });
    expect(await s.isRunning()).toBe(false);
    expect(await s.isRunning()).toBe(false); // 熔断，until=6000
    expect(s.isCircuitOpen()).toBe(true);

    t = 7000; // 冷却结束，半开
    expect(await s.isRunning()).toBe(false); // 半开探测失败 → 重新熔断
    expect(s.isCircuitOpen()).toBe(true); // until=12000
  });

  it("熔断开启期间推进时间但未越冷却 → 仍熔断", async () => {
    const { client } = makeFakeClient(() =>
      Promise.reject(new Error("timeout")),
    );
    let t = 1000;
    const s = new GatewayLifecycleManager({
      client,
      failureThreshold: 1,
      cooldownMs: 5000,
      healthRetries: 1,
      sleep: noSleep,
      now: () => t,
    });
    expect(await s.isRunning()).toBe(false); // 1 次即熔断，until=6000
    expect(s.isCircuitOpen()).toBe(true);

    t = 5999; // 未越冷却
    expect(s.isCircuitOpen()).toBe(true);
    expect(await s.isRunning()).toBe(false);

    t = 6000; // 恰好越冷却
    expect(s.isCircuitOpen()).toBe(false);
  });

  // ─── ensureAlive ──────────────────────────────────────────────────────────

  it("ensureAlive v1 等同 isRunning（仅探测不拉起）", async () => {
    const { client, healthCalls } = makeFakeClient(() =>
      Promise.resolve({ status: "ok" }),
    );
    const s = new GatewayLifecycleManager({ client, healthRetries: 1, sleep: noSleep });
    expect(await s.ensureAlive()).toBe(true);
    expect(healthCalls()).toBe(1);
  });

  it("ensureAlive 熔断时也返回 false 且不探测", async () => {
    const { client, healthCalls } = makeFakeClient(() =>
      Promise.reject(new Error("timeout")),
    );
    const s = new GatewayLifecycleManager({
      client,
      failureThreshold: 1,
      healthRetries: 1,
      sleep: noSleep,
    });
    expect(await s.ensureAlive()).toBe(false); // 熔断
    const callsBefore = healthCalls();
    expect(await s.ensureAlive()).toBe(false);
    expect(healthCalls()).toBe(callsBefore);
  });

  // ─── 默认值 ───────────────────────────────────────────────────────────────

  it("默认参数：failureThreshold=5 / cooldownMs=60000 / healthRetries=3", async () => {
    const { client, healthCalls } = makeFakeClient(() =>
      Promise.reject(new Error("timeout")),
    );
    const s = new GatewayLifecycleManager({ client, sleep: noSleep });
    // 单次 isRunning 应重试 3 次
    expect(await s.isRunning()).toBe(false);
    expect(healthCalls()).toBe(3);
    // 5 次后才熔断
    expect(s.isCircuitOpen()).toBe(false);
    for (let i = 0; i < 4; i++) await s.isRunning();
    expect(s.isCircuitOpen()).toBe(true);
  });
});
