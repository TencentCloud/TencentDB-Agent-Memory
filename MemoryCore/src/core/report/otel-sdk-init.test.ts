import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let releaseSdkImport = () => {};
  let sdkImportGate = Promise.resolve();
  let releaseSdkShutdown = () => {};
  let sdkShutdownGate = Promise.resolve();
  let constructionError: Error | undefined;

  const nodeSDKConstructed = vi.fn();
  const sdkStart = vi.fn();
  const sdkShutdown = vi.fn(() => sdkShutdownGate);
  const loggerShutdown = vi.fn().mockResolvedValue(undefined);
  const diagWarn = vi.fn();

  return {
    nodeSDKConstructed,
    sdkStart,
    sdkShutdown,
    loggerShutdown,
    diagWarn,
    waitForSdkImport: () => sdkImportGate,
    deferSdkImport: () => {
      sdkImportGate = new Promise<void>((resolve) => {
        releaseSdkImport = resolve;
      });
    },
    releaseSdkImport: () => releaseSdkImport(),
    deferSdkShutdown: () => {
      sdkShutdownGate = new Promise<void>((resolve) => {
        releaseSdkShutdown = resolve;
      });
    },
    releaseSdkShutdown: () => releaseSdkShutdown(),
    failNextConstruction: (error: Error) => {
      constructionError = error;
    },
    takeConstructionError: () => {
      const error = constructionError;
      constructionError = undefined;
      return error;
    },
    reset: () => {
      releaseSdkImport();
      releaseSdkShutdown();
      releaseSdkImport = () => {};
      sdkImportGate = Promise.resolve();
      releaseSdkShutdown = () => {};
      sdkShutdownGate = Promise.resolve();
      constructionError = undefined;
      nodeSDKConstructed.mockClear();
      sdkStart.mockClear();
      sdkShutdown.mockClear();
      loggerShutdown.mockClear();
      diagWarn.mockClear();
    },
  };
});

vi.mock("@opentelemetry/api", () => ({
  diag: {
    setLogger: vi.fn(),
    warn: mocks.diagWarn,
  },
  DiagConsoleLogger: class {},
  DiagLogLevel: { DEBUG: 1 },
  trace: {},
}));

vi.mock("@opentelemetry/sdk-node", async () => {
  await mocks.waitForSdkImport();
  return {
    NodeSDK: class {
      constructor() {
        mocks.nodeSDKConstructed();
        const error = mocks.takeConstructionError();
        if (error) throw error;
      }

      start() {
        mocks.sdkStart();
      }

      shutdown() {
        return mocks.sdkShutdown();
      }
    },
  };
});

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn((attributes) => ({ attributes })),
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
  ATTR_SERVICE_VERSION: "service.version",
  ATTR_SERVICE_INSTANCE_ID: "service.instance.id",
}));

vi.mock("@opentelemetry/exporter-trace-otlp-grpc", () => ({
  OTLPTraceExporter: class {},
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {},
}));

vi.mock("@opentelemetry/exporter-logs-otlp-grpc", () => ({
  OTLPLogExporter: class {},
}));

vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: class {},
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  LoggerProvider: class {
    shutdown() {
      return mocks.loggerShutdown();
    }
  },
  BatchLogRecordProcessor: class {},
}));

vi.mock("@opentelemetry/context-async-hooks", () => ({
  AsyncLocalStorageContextManager: class {},
}));

vi.mock("@opentelemetry/api-logs", () => ({
  logs: {
    setGlobalLoggerProvider: vi.fn(),
  },
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: class {},
  SimpleSpanProcessor: class {},
}));

vi.mock("./langfuse-span-processor.js", () => ({
  LangfuseFilteringProcessor: class {
    shutdown() {
      return Promise.resolve();
    }
  },
}));

async function loadModule() {
  return import("./otel-sdk-init.js");
}

describe("OTel SDK lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.reset();
    vi.stubEnv("CLICKHOUSE_ENABLED", "false");
    vi.stubEnv("LANGFUSE_ENABLED", "false");
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    mocks.releaseSdkImport();
    mocks.releaseSdkShutdown();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("shares one in-flight initialization", async () => {
    mocks.deferSdkImport();
    const { initOTelSDK, shutdownOTelSDK } = await loadModule();

    const first = initOTelSDK({ endpoint: "http://otel.test:4317" });
    const second = initOTelSDK({ endpoint: "http://otel.test:4317" });

    expect(second).toBe(first);
    expect(mocks.nodeSDKConstructed).not.toHaveBeenCalled();

    mocks.releaseSdkImport();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

    expect(mocks.nodeSDKConstructed).toHaveBeenCalledTimes(1);
    expect(mocks.sdkStart).toHaveBeenCalledTimes(1);
    await shutdownOTelSDK();
  });

  it("waits for initialization before shared shutdown", async () => {
    mocks.deferSdkImport();
    const {
      initOTelSDK,
      isOTelSDKInitialized,
      shutdownOTelSDK,
    } = await loadModule();

    const initialization = initOTelSDK({
      endpoint: "http://otel.test:4317",
    });
    const firstShutdown = shutdownOTelSDK();
    const secondShutdown = shutdownOTelSDK();

    expect(secondShutdown).toBe(firstShutdown);
    expect(mocks.sdkShutdown).not.toHaveBeenCalled();

    mocks.releaseSdkImport();
    await initialization;
    await firstShutdown;

    expect(mocks.sdkShutdown).toHaveBeenCalledTimes(1);
    expect(mocks.loggerShutdown).toHaveBeenCalledTimes(1);
    expect(isOTelSDKInitialized()).toBe(false);
  });

  it("defers reinitialization until shutdown completes", async () => {
    const {
      initOTelSDK,
      isOTelSDKInitialized,
      shutdownOTelSDK,
    } = await loadModule();
    await initOTelSDK({ endpoint: "http://otel.test:4317" });
    mocks.deferSdkShutdown();

    const shutdown = shutdownOTelSDK();
    const reinitialization = initOTelSDK({
      endpoint: "http://otel.test:4317",
    });
    await Promise.resolve();

    expect(mocks.nodeSDKConstructed).toHaveBeenCalledTimes(1);

    mocks.releaseSdkShutdown();
    await shutdown;
    await expect(reinitialization).resolves.toBe(true);

    expect(mocks.nodeSDKConstructed).toHaveBeenCalledTimes(2);
    expect(mocks.sdkStart).toHaveBeenCalledTimes(2);
    expect(isOTelSDKInitialized()).toBe(true);
    await shutdownOTelSDK();
  });

  it("allows retry after initialization fails", async () => {
    const { initOTelSDK, shutdownOTelSDK } = await loadModule();
    mocks.failNextConstruction(new Error("SDK unavailable"));

    await expect(
      initOTelSDK({ endpoint: "http://otel.test:4317" }),
    ).resolves.toBe(false);
    await expect(
      initOTelSDK({ endpoint: "http://otel.test:4317" }),
    ).resolves.toBe(true);

    expect(mocks.nodeSDKConstructed).toHaveBeenCalledTimes(2);
    expect(mocks.sdkStart).toHaveBeenCalledTimes(1);
    expect(mocks.diagWarn).toHaveBeenCalledWith(
      expect.stringContaining("SDK unavailable"),
    );
    await shutdownOTelSDK();
  });
});
