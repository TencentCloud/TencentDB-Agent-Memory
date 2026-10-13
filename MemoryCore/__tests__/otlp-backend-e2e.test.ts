import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { OtlpObservabilityBackend } from "../src/core/report/otlp-backend.js";

describe("OtlpObservabilityBackend E2E with local receiver", () => {
  let server: http.Server;
  let serverUrl: string;
  let backend: OtlpObservabilityBackend | undefined;
  const receivedRequests: Array<{
    url: string;
    method: string;
    body: string;
  }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => {
        receivedRequests.push({
          url: req.url ?? "/",
          method: req.method ?? "UNKNOWN",
          body: data,
        });
        res.writeHead(200);
        res.end("{}");
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number; address: string };
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    try {
      await backend?.shutdown();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("should send traces and logs to local receiver and shutdown cleanly", async () => {
    backend = new OtlpObservabilityBackend();

    await backend.initialize({
      type: "otlp",
      otel: {
        enabled: true,
        endpoint: serverUrl,
        protocol: "http",
        serviceName: "test-e2e-service"
      }
    });

    // Send a trace
    const span = backend.trace.start("e2e-trace-span");
    span.setAttribute("test.attribute", "trace-e2e-value");
    span.end();

    // Send a log
    backend.log.info("e2e-log-event", { "test.log.attr": "log-e2e-value" });

    // Wait and shutdown which should flush
    await new Promise(resolve => setTimeout(resolve, 500));
    await backend.shutdown();

    const traceReqs = receivedRequests.filter(r => r.url === "/v1/traces");
    const logReqs = receivedRequests.filter(r => r.url === "/v1/logs");

    expect(traceReqs.length).toBeGreaterThan(0);
    expect(traceReqs.some(r => r.body.includes("e2e-trace-span") && r.body.includes("trace-e2e-value"))).toBe(true);

    expect(logReqs.length).toBeGreaterThan(0);
    expect(logReqs.some(r => r.body.includes("e2e-log-event") && r.body.includes("log-e2e-value"))).toBe(true);
  });
});
