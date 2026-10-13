import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPTraceExporter as GrpcTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPLogExporter as GrpcLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";

describe("OpenTelemetry exporters real integration with local HTTP receiver and gRPC lifecycle", () => {
  let server: http.Server;
  let serverUrl: string;
  const receivedRequests: Array<{
    url: string;
    method: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => {
        receivedRequests.push({
          url: req.url ?? "/",
          method: req.method ?? "UNKNOWN",
          headers: req.headers,
          body: data,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
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
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("exports traces over HTTP to local receiver using OTLPTraceExporter and resourceFromAttributes", async () => {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "test-service-trace",
    });

    const traceExporter = new OTLPTraceExporter({
      url: `${serverUrl}/v1/traces`,
    });

    const tracerProvider = new BasicTracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor(traceExporter)],
    });

    const tracer = tracerProvider.getTracer("test-tracer");
    const span = tracer.startSpan("test-synthetic-span");
    span.setAttribute("test.attribute", "synthetic-trace-data");
    span.end();

    await tracerProvider.forceFlush();
    await tracerProvider.shutdown();

    const traceReqs = receivedRequests.filter((r) => r.url === "/v1/traces");
    expect(traceReqs.length).toBeGreaterThan(0);
    const lastTraceReq = traceReqs[traceReqs.length - 1];
    expect(lastTraceReq.method).toBe("POST");
    expect(lastTraceReq.body).toContain("test-synthetic-span");
  });

  it("exports logs over HTTP to local receiver using OTLPLogExporter and resourceFromAttributes", async () => {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "test-service-log",
    });

    const logExporter = new OTLPLogExporter({
      url: `${serverUrl}/v1/logs`,
    });

    const loggerProvider = new LoggerProvider({
      resource,
      processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
    });

    const logger = loggerProvider.getLogger("test-logger");
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "test-synthetic-log-message",
      attributes: {
        "test.key": "synthetic-log-val",
      },
    });

    await loggerProvider.forceFlush();
    await loggerProvider.shutdown();

    const logReqs = receivedRequests.filter((r) => r.url === "/v1/logs");
    expect(logReqs.length).toBeGreaterThan(0);
    const lastLogReq = logReqs[logReqs.length - 1];
    expect(lastLogReq.method).toBe("POST");
    expect(lastLogReq.body).toContain("test-synthetic-log-message");
  });

  it("verifies installed gRPC exporters initialize and shut down cleanly", async () => {
    const grpcTrace = new GrpcTraceExporter({ url: "localhost:4317" });
    expect(grpcTrace).toBeDefined();
    await expect(grpcTrace.shutdown()).resolves.toBeUndefined();

    const grpcLog = new GrpcLogExporter({ url: "localhost:4317" });
    expect(grpcLog).toBeDefined();
    await expect(grpcLog.shutdown()).resolves.toBeUndefined();
  });
});
