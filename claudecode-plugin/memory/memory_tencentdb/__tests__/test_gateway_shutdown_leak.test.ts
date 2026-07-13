/**
 * Tests for the adapter SDK Gateway ownership contract.
 *
 * Mirrors the Hermes test_gateway_shutdown_leak.py scope for Claude Code:
 * Claude Code does not own the Gateway process, so it must never auto-spawn
 * or terminate Gateway. The plugin may only check health and tell the user to
 * start Gateway manually.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureGateway } from "../../../../src/adapters/adapter-sdk/gateway-supervisor.js";

const PLUGIN_DIR = join(__dirname, "..");
const REPO_ROOT = join(PLUGIN_DIR, "..", "..", "..");
const SDK_DIR = join(REPO_ROOT, "src", "adapters", "adapter-sdk");

describe("GatewayShutdownLeakTest", () => {
  it("does not spawn Gateway when health check fails", async () => {
    const gateway = {
      baseUrl: "http://127.0.0.1:18420",
      isHealthy: vi.fn().mockResolvedValue(false),
    };
    const logger = { warn: vi.fn() };

    const ok = await ensureGateway({ gateway: gateway as never, logger });

    expect(ok).toBe(false);
    expect(gateway.isHealthy).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Start it manually with: node --import tsx src/gateway/server.ts"),
    );
  });

  it("does not warn or change process ownership when Gateway is healthy", async () => {
    const gateway = {
      baseUrl: "http://127.0.0.1:8420",
      isHealthy: vi.fn().mockResolvedValue(true),
    };
    const logger = { warn: vi.fn() };

    const ok = await ensureGateway({ gateway: gateway as never, logger });

    expect(ok).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("SDK supervisor contains no child-process spawn path", () => {
    const source = readFileSync(join(SDK_DIR, "gateway-supervisor.ts"), "utf-8");

    expect(source).toContain("ensureGateway");
    expect(source).toContain("isHealthy");
    expect(source).not.toContain("child_process");
    expect(source).not.toContain("spawn(");
    expect(source).not.toContain("MEMORY_TENCENTDB_GATEWAY_CMD");
  });

  it("Claude Code entrypoints delegate lifecycle behavior to the adapter SDK", () => {
    const mcpSource = readFileSync(join(PLUGIN_DIR, "mcp-server.ts"), "utf-8");
    const recallSource = readFileSync(join(PLUGIN_DIR, "hooks", "recall.ts"), "utf-8");
    const captureSource = readFileSync(join(PLUGIN_DIR, "hooks", "capture.ts"), "utf-8");

    expect(mcpSource).toContain("runMemoryMcpServer");
    expect(recallSource).toContain("runRecallHook");
    expect(captureSource).toContain("runCaptureHook");
    expect(mcpSource).not.toContain("spawn");
    expect(recallSource).not.toContain("spawn");
    expect(captureSource).not.toContain("spawn");
  });
});
