import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { GatewaySupervisor } from "../src/gateway-supervisor.js";
import type { GatewayClient } from "../src/gateway-client.js";

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("GatewaySupervisor", () => {
  it("reuses an external healthy Gateway and never spawns", async () => {
    const spawnImpl = vi.fn();
    const client = {
      health: vi.fn(async () => ({ status: "ok" })),
    } as unknown as GatewayClient;
    const supervisor = new GatewaySupervisor({
      client,
      gatewayUrl: "http://127.0.0.1:8420",
      gatewayCommand: "node gateway.js",
      logDir: process.cwd(),
      startupTimeoutMs: 100,
      enabled: true,
      logger: logger(),
      spawnImpl,
    });
    expect(await supervisor.ensureRunning()).toBe(true);
    await supervisor.shutdown();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("stops only the child it started", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      killed: boolean;
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    child.exitCode = null;
    child.killed = false;
    child.pid = 123;
    child.kill = vi.fn(() => {
      child.killed = true;
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0));
      return true;
    });
    const health = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ status: "ok" });
    const supervisor = new GatewaySupervisor({
      client: { health } as unknown as GatewayClient,
      gatewayUrl: "http://127.0.0.1:8420",
      gatewayCommand: "node gateway.js",
      logDir: process.cwd(),
      startupTimeoutMs: 100,
      enabled: true,
      logger: logger(),
      spawnImpl: vi.fn(() => child) as never,
    });
    expect(await supervisor.ensureRunning()).toBe(true);
    await supervisor.shutdown();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
