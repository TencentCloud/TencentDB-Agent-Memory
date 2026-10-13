import { diag, DiagLogLevel } from "@opentelemetry/api";
import { afterEach, expect, it, vi } from "vitest";
import { initOTelSDK, shutdownOTelSDK } from "../src/core/report/otel-sdk-init.js";

afterEach(async () => {
  await shutdownOTelSDK();
  diag.disable();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("omits configured collector URLs and private identifiers from initialization logs", async () => {
  vi.stubEnv("CLICKHOUSE_ENABLED", "false");
  vi.stubEnv("LANGFUSE_ENABLED", "false");
  const messages: unknown[][] = [];
  for (const method of ["info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args) => { messages.push(args); });
  }
  const secrets = ["synthetic-endpoint-secret", "synthetic-langfuse-secret", "synthetic-private-service", "private-tenant-id"];
  expect(await initOTelSDK({
    endpoint: `http://127.0.0.1:9/private?token=${secrets[0]}`,
    protocol: "http/protobuf",
    serviceName: secrets[2],
    tenantId: secrets[3],
    clickhouse: false,
    langfuse: { host: `http://127.0.0.1:9/private?token=${secrets[1]}`, publicKey: "synthetic-public", secretKey: "synthetic-key" },
  })).toBe(true);
  // No spans or logs are emitted: no exporter sends telemetry to the fixture URL.
  await shutdownOTelSDK();
  expect(JSON.stringify(messages)).toContain("SDK initialized");
  expect(JSON.stringify(messages)).toContain("Langfuse exporter enabled");
  for (const secret of secrets) expect(JSON.stringify(messages)).not.toContain(secret);
});

it("omits invalid metadata details from initialization failure diagnostics", async () => {
  const messages: unknown[][] = [];
  const capture = (...args: unknown[]) => { messages.push(args); };
  diag.setLogger({ debug: capture, info: capture, warn: capture, error: capture, verbose: capture }, DiagLogLevel.WARN);
  const privateKey = "synthetic private credential marker";
  expect(await initOTelSDK({
    endpoint: "http://127.0.0.1:9",
    protocol: "grpc",
    headers: { [privateKey]: "synthetic-private-value" },
    clickhouse: false,
    langfuse: false,
  })).toBe(false);
  expect(JSON.stringify(messages)).toContain("Failed to initialize OTel SDK");
  expect(JSON.stringify(messages)).not.toContain(privateKey);
  expect(JSON.stringify(messages)).not.toContain("synthetic-private-value");
});
