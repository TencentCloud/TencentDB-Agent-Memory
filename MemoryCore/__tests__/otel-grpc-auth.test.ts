import { createServer } from "node:http2";
import { once } from "node:events";
import { logs } from "@opentelemetry/api-logs";
import { trace } from "@opentelemetry/api";
import { expect, it, vi } from "vitest";
import { initOTelSDK, shutdownOTelSDK } from "../src/core/report/otel-sdk-init.js";

it("sends configured authentication metadata for actual gRPC traces and logs", async () => {
  vi.stubEnv("LANGFUSE_ENABLED", "false");
  vi.stubEnv("CLICKHOUSE_ENABLED", "false");
  // Explicit configuration must win over the common environment header.
  vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer synthetic-environment");
  const received: { path: string; authorization: unknown; tenant: unknown }[] = [];
  const server = createServer();
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    stream.on("data", () => {});
    stream.on("end", () => {
      received.push({ path: String(headers[":path"]), authorization: headers.authorization, tenant: headers["x-synthetic-tenant"] });
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      // A successful, empty protobuf ExportResponse with its gRPC frame prefix.
      stream.end(Buffer.alloc(5));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing synthetic collector address");
  try {
    expect(await initOTelSDK({
      endpoint: `http://127.0.0.1:${address.port}`,
      protocol: "grpc",
      headers: { authorization: "Bearer synthetic-configured", "x-synthetic-tenant": "synthetic-team" },
      langfuse: false,
      clickhouse: false,
    })).toBe(true);
    trace.getTracer("synthetic-grpc-test").startSpan("synthetic-span").end();
    logs.getLogger("synthetic-grpc-test").emit({ body: "synthetic-log" });
    await shutdownOTelSDK();
    expect(received.map(row => row.path).sort()).toEqual([
      "/opentelemetry.proto.collector.logs.v1.LogsService/Export",
      "/opentelemetry.proto.collector.trace.v1.TraceService/Export",
    ]);
    for (const row of received) {
      expect(row.authorization).toBe("Bearer synthetic-configured");
      expect(row.tenant).toBe("synthetic-team");
    }
  } finally {
    await shutdownOTelSDK();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    vi.unstubAllEnvs();
  }
});
