import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { initOTelSDK, shutdownOTelSDK, isOTelSDKInitialized } from "../src/core/report/otel-sdk-init.js";
import { logs } from "@opentelemetry/api-logs";

describe("otel-sdk-init integration test", () => {
  let server: http.Server;
  let serverUrl: string;
  const receivedLogs: any[] = [];

  // Store env backup
  const originalEnv = process.env;

  beforeAll(async () => {
    process.env = { ...originalEnv };
    // Disable external integrations
    process.env.LANGFUSE_ENABLED = "false";
    process.env.CLICKHOUSE_ENABLED = "false";

    server = http.createServer((req, res) => {
      let data = "";
      req.on("data", chunk => data += chunk);
      req.on("end", () => {
        if (req.url === "/v1/logs") {
          receivedLogs.push(data);
        }
        res.writeHead(200);
        res.end("{}");
      });
    });

    await new Promise<void>(resolve => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    process.env = originalEnv;
  });

  it("should initialize SDK, export logs via BatchLogRecordProcessor, and shutdown cleanly", async () => {
    try {
      const initialized = await initOTelSDK({
        endpoint: serverUrl,
        protocol: "http/protobuf",
        serviceName: "test-init-service",
        logExportIntervalMs: 100, // Small interval for testing
        langfuse: false,
        clickhouse: false
      });

      expect(initialized).toBe(true);
      expect(isOTelSDKInitialized()).toBe(true);

      const loggerProvider = logs.getLoggerProvider();
      const logger = loggerProvider.getLogger("test-init-logger");

      logger.emit({
        severityText: "INFO",
        body: "test-init-log-message",
        attributes: {
          "test.init.key": "test.init.val"
        }
      });

      // Force flush isn't directly exposed on global API easily,
      // but shutdown will flush the batch processor.
      await shutdownOTelSDK();

      expect(isOTelSDKInitialized()).toBe(false);

      expect(receivedLogs.length).toBeGreaterThan(0);
      const logBody = receivedLogs.join();
      expect(logBody).toContain("test-init-log-message");
    } finally {
      // Ensure cleanup even if assertion fails
      if (isOTelSDKInitialized()) {
        await shutdownOTelSDK();
      }
    }
  });
});
