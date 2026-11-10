import { beforeEach, describe, expect, it, vi } from "vitest";

const otel = vi.hoisted(() => ({
  sdkOptions: [] as Record<string, unknown>[],
  resourceFromAttributes: vi.fn(() => ({
    attributes: { "service.name": "otlp-test-service" },
  })),
  sdkStart: vi.fn(),
}));

vi.mock("@opentelemetry/api", () => ({
  trace: {},
  context: {},
  propagation: {},
  SpanKind: {},
  SpanStatusCode: {},
  ROOT_CONTEXT: {},
  TraceFlags: {},
  metrics: { getMeter: vi.fn() },
}));

vi.mock("@opentelemetry/api-logs", () => ({
  logs: {},
  SeverityNumber: {},
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: otel.resourceFromAttributes,
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    constructor(options: Record<string, unknown>) {
      otel.sdkOptions.push(options);
    }

    start = otel.sdkStart;
  },
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {},
}));

vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: class {},
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  SimpleLogRecordProcessor: class {},
}));

const { OtlpObservabilityBackend } = await import("./otlp-backend.js");

describe("OtlpObservabilityBackend", () => {
  beforeEach(() => {
    otel.sdkOptions.length = 0;
    otel.resourceFromAttributes.mockClear();
    otel.sdkStart.mockClear();
  });

  it("initializes OTel from the v2 resource factory", async () => {
    const backend = new OtlpObservabilityBackend();

    await backend.initialize({
      type: "otlp",
      otel: {
        enabled: true,
        endpoint: "http://collector:4318",
        serviceName: "otlp-test-service",
      },
    });

    expect(otel.resourceFromAttributes).toHaveBeenCalledWith({
      "service.name": "otlp-test-service",
    });
    expect(otel.sdkOptions).toHaveLength(1);
    expect(otel.sdkOptions[0].resource).toEqual({
      attributes: { "service.name": "otlp-test-service" },
    });
    expect(otel.sdkStart).toHaveBeenCalledOnce();
  });
});
