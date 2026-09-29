import { describe, expect, it, vi } from "vitest";
import { GatewaySupervisor } from "../src/gateway-supervisor.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("GatewaySupervisor", () => {
  it("reuses an externally healthy Gateway without spawning a child", async () => {
    const health = vi.fn().mockResolvedValue({ status: "ok" });
    const spawnImpl = vi.fn();
    const supervisor = new GatewaySupervisor({
      client: { health } as never,
      gatewayUrl: "http://127.0.0.1:8420",
      logDir: "logs",
      logger,
      enabled: true,
      spawnImpl: spawnImpl as never,
    });
    await expect(supervisor.ensureRunning()).resolves.toBe(true);
    expect(spawnImpl).not.toHaveBeenCalled();
    await supervisor.shutdown();
  });

  it("reports an absent Gateway when supervision is disabled", async () => {
    const supervisor = new GatewaySupervisor({
      client: { health: vi.fn().mockRejectedValue(new Error("offline")) } as never,
      gatewayUrl: "http://127.0.0.1:8420",
      logDir: "logs",
      logger,
      enabled: false,
      cwd: "C:\\not-a-memory-workspace",
    });
    await expect(supervisor.ensureRunning()).resolves.toBe(false);
  });
});
