/**
 * doStop() ordering:
 *  1. the HTTP server stops accepting connections FIRST (no new requests
 *     mid-shutdown), and in-flight requests must DRAIN before any
 *     store/pool/backend closes (otherwise they'd hit closed stores);
 *  2. the OTel SDK flushes LAST (spans/logs emitted during shutdown
 *     itself must still be exported).
 */
import { describe, it, expect, vi } from "vitest";

const events = vi.hoisted(() => [] as string[]);

vi.mock("../core/report/otel-sdk-init.js", () => ({
  initOTelSDK: vi.fn(async () => {}),
  shutdownOTelSDK: vi.fn(async () => {
    events.push("otel.shutdown");
  }),
}));

import { TdaiGateway } from "./server.js";

function makeGateway(): InstanceType<typeof TdaiGateway> {
  const gw = Object.create(TdaiGateway.prototype) as Record<string, unknown>;
  Object.assign(gw, {
    config: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    core: {
      destroy: async () => {
        events.push("core.destroy");
      },
    },
    server: {
      close(cb: () => void) {
        events.push("server.close");
        // In-flight drain completes one tick later.
        setImmediate(() => {
          events.push("server.drained");
          cb();
        });
      },
      closeIdleConnections() {
        events.push("server.closeIdleConnections");
      },
      closeAllConnections() {
        events.push("server.closeAllConnections");
      },
    },
    pipelineWorker: null,
    skillWorkerPool: null,
    conversationAddByInstance: new Map(),
    timerScanner: null,
    stateBackend: {
      destroy: async () => {
        events.push("stateBackend.destroy");
      },
    },
    storePool: {
      setGraceCloseDelay() {},
      closeAll: async () => {
        events.push("storePool.closeAll");
      },
    },
    metadataStorePool: null,
    analyticsChClientInstance: undefined,
    analyticsChInitPromise: null,
  });
  return gw as unknown as InstanceType<typeof TdaiGateway>;
}

describe("TdaiGateway.doStop", () => {
  it("stops accepting connections first and flushes OTel last", async () => {
    events.length = 0;
    const gw = makeGateway();
    await (gw as unknown as { doStop(): Promise<void> }).doStop();

    expect(events[0]).toBe("server.close");
    expect(events[1]).toBe("server.closeIdleConnections");
    expect(events.indexOf("server.close")).toBeLessThan(events.indexOf("core.destroy"));
    expect(events.indexOf("core.destroy")).toBeLessThan(events.indexOf("otel.shutdown"));
    expect(events[events.length - 1]).toBe("otel.shutdown");
  });

  it("drains in-flight requests before closing stores/backends", async () => {
    events.length = 0;
    const gw = makeGateway();
    await (gw as unknown as { doStop(): Promise<void> }).doStop();

    const drained = events.indexOf("server.drained");
    expect(drained).toBeGreaterThan(-1);
    expect(drained).toBeLessThan(events.indexOf("storePool.closeAll"));
    expect(drained).toBeLessThan(events.indexOf("stateBackend.destroy"));
    expect(events.indexOf("storePool.closeAll")).toBeLessThan(events.indexOf("core.destroy"));
  });
});
