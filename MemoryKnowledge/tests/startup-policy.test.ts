import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We use vi.hoisted to ensure we capture state across the module import lifecycle.
const { telemetryState } = vi.hoisted(() => ({
  telemetryState: {
    initCalls: 0,
    importTimeCalls: 0,
  },
}));

vi.mock("../src/telemetry.js", () => ({
  initTelemetry: vi.fn(() => {
    telemetryState.initCalls++;
  }),
  shutdownTelemetry: vi.fn(async () => {}),
  isTelemetryInitialized: vi.fn(() => telemetryState.initCalls > 0),
  tracer: {
    startActiveSpan: vi.fn((_name: string, fn: Function) => fn({ setAttribute: vi.fn(), end: vi.fn() })),
  },
  withSpan: vi.fn(async (_name: string, fn: Function) => fn({ setAttribute: vi.fn(), end: vi.fn() })),
}));

// We import the actual exported startServer to test it directly.
import { startServer, createApp } from "../src/server.js";
import { isLoopbackHost, validateListenerConfig } from "../src/config.js";

// Right after import, record how many times initTelemetry was called eagerly.
telemetryState.importTimeCalls = telemetryState.initCalls;

describe("Listener posture & startup security policy", () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // DO NOT reset importTimeCalls to prove eager init wasn't covered up.
    telemetryState.initCalls = 0;
    vi.clearAllMocks();
    originalEnv = process.env;
    process.env = { ...originalEnv };
    tmpDir = mkdtempSync(join(tmpdir(), "knowledge-startup-test-"));
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("isLoopbackHost", () => {
    it("recognizes standard loopback addresses", () => {
      expect(isLoopbackHost("127.0.0.1")).toBe(true);
      expect(isLoopbackHost("127.0.0.2")).toBe(true);
      expect(isLoopbackHost("localhost")).toBe(true);
      expect(isLoopbackHost("::1")).toBe(true);
    });

    it("identifies non-loopback addresses correctly", () => {
      expect(isLoopbackHost("0.0.0.0")).toBe(false);
      expect(isLoopbackHost("192.168.1.100")).toBe(false);
      expect(isLoopbackHost("")).toBe(false);
    });
  });

  describe("validateListenerConfig", () => {
    it("allows loopback listening without serviceKey for local development", () => {
      expect(() => {
        validateListenerConfig({ host: "127.0.0.1", auth: { serviceKey: "" } });
      }).not.toThrow();
    });

    it("refuses non-loopback listening without serviceKey and without opt-in", () => {
      expect(() => {
        validateListenerConfig({ host: "0.0.0.0", auth: { serviceKey: "" } });
      }).toThrow(/Refusing to bind to non-loopback host "0\.0\.0\.0" without KNOWLEDGE_SERVICE_KEY/);
    });

    it("allows non-loopback listening when serviceKey is provided", () => {
      expect(() => {
        validateListenerConfig({ host: "0.0.0.0", auth: { serviceKey: "strong-random-service-key" } });
      }).not.toThrow();
    });

    it("allows non-loopback listening without serviceKey ONLY when explicit opt-in is enabled", () => {
      expect(() => {
        validateListenerConfig({ host: "0.0.0.0", auth: { serviceKey: "", allowInsecureNoKeyListen: true } });
      }).not.toThrow();
    });
  });

  describe("Telemetry side-effect ordering", () => {
    it("importing modules must not trigger initTelemetry eagerly", () => {
      expect(telemetryState.importTimeCalls).toBe(0);
    });

    it("createApp does NOT trigger initTelemetry", () => {
      const appInstance = createApp({
        dbPath: ":memory:",
        dataDir: tmpDir,
        host: "127.0.0.1",
        port: 8421,
        apiPrefix: "/v3",
        logLevel: "debug",
        publicBaseUrl: "",
        tmcCallbackUrl: "",
        clickhouse: { enabled: false } as any,
        llm: { mode: "proxy" } as any,
        auth: { serviceKey: "", allowInsecureNoKeyListen: false },
      });
      expect(appInstance.app).toBeDefined();
      expect(telemetryState.initCalls).toBe(0);
      appInstance.close();
    });

    it("proves actual startServer rejects invalid listener config before telemetry initialization", async () => {
      // Set environment variables to force an invalid non-loopback configuration
      process.env.KNOWLEDGE_HOST = "0.0.0.0";
      process.env.KNOWLEDGE_SERVICE_KEY = "";
      process.env.KNOWLEDGE_ALLOW_INSECURE_NO_KEY_LISTEN = "false";
      process.env.KNOWLEDGE_DATA_DIR = tmpDir;
      process.env.KNOWLEDGE_DB_PATH = join(tmpDir, "test.db");

      // Verify that startServer rejects due to validation failure.
      await expect(startServer()).rejects.toThrow(/Refusing to bind to non-loopback host/);

      // CRITICAL: initTelemetry MUST NOT have been called.
      // If a mutation moves initTelemetry() before validateListenerConfig(config) in startServer,
      // telemetryState.initCalls will be > 0 and this assertion will fail.
      expect(telemetryState.initCalls).toBe(0);
    });
  });
});
