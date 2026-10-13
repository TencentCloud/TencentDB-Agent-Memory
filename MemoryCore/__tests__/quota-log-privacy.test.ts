import { expect, it, vi } from "vitest";
import { QuotaManager } from "../src/core/quota/quota-manager.js";

const instance = "synthetic-private-instance";
const failure = "synthetic-private-backend-payload";
function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}
function assertPrivate(log: ReturnType<typeof logger>) {
  const messages = JSON.stringify(Object.values(log).map(fn => fn.mock.calls));
  expect(messages).not.toContain(instance);
  expect(messages).not.toContain(failure);
}

it("keeps default quota fallback on fetch failure without logging private details", async () => {
  const log = logger();
  const manager = new QuotaManager({ reporter: { fetchQuota: vi.fn().mockRejectedValue(new Error(failure)), reportUsage: vi.fn() }, logger: log });
  expect(await manager.getQuota(instance)).toEqual({ memoryLimit: 10_000, creditLimit: 1_000, memoryUsage: 0, creditUsage: 0 });
  expect(log.warn).toHaveBeenCalledOnce();
  assertPrivate(log);
});

it("contains usage-report failure without changing cached usage or logging payloads", async () => {
  const log = logger();
  const snapshot = { memoryLimit: 2, creditLimit: 2, memoryUsage: 1, creditUsage: 1 };
  const manager = new QuotaManager({ reporter: { fetchQuota: vi.fn().mockResolvedValue(snapshot), reportUsage: vi.fn().mockRejectedValue(new Error(failure)) }, logger: log });
  await manager.getQuota(instance);
  await expect(manager.reportUsage(instance, 2, 3, "L1")).resolves.toBeUndefined();
  expect(await manager.getQuota(instance)).toEqual(snapshot);
  expect(log.error).toHaveBeenCalledOnce();
  assertPrivate(log);
});

it("preserves reporter arguments, cache accounting and enforcement without logging instance identity", async () => {
  const log = logger();
  const reportUsage = vi.fn().mockResolvedValue(undefined);
  const manager = new QuotaManager({ reporter: { fetchQuota: vi.fn().mockResolvedValue({ memoryLimit: 2, creditLimit: 2, memoryUsage: 1, creditUsage: 1 }), reportUsage }, logger: log });
  await manager.getQuota(instance);
  await manager.reportUsage(instance, 2, 3, "L1");
  expect(reportUsage).toHaveBeenCalledExactlyOnceWith(instance, 2, 3, "L1");
  expect(await manager.checkMemoryQuota(instance)).toEqual({ allowed: false, reason: "memory_limit_exceeded", current: 3, limit: 2 });
  expect(await manager.checkCreditQuota(instance)).toEqual({ allowed: false, reason: "credit_limit_exceeded", current: 4, limit: 2 });
  expect(log.debug).toHaveBeenCalledOnce();
  assertPrivate(log);
});
