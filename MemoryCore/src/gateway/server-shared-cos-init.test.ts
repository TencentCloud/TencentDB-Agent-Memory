/**
 * initSharedCosClient in-flight dedupe: concurrent lazy callers must share
 * one init attempt instead of each constructing a SharedCosClient /
 * credential provider.
 */
import { describe, it, expect, vi } from "vitest";
import { TdaiGateway } from "./server.js";

type Gw = {
  sharedCosClient: unknown;
  sharedCosInitPromise: Promise<void> | null;
  configProvider: unknown;
  doInitSharedCosClient: (maxRetries: number) => Promise<void>;
  initSharedCosClient: (maxRetries?: number) => Promise<void>;
};

function makeGateway(): { gw: Gw; doSpy: ReturnType<typeof vi.fn> } {
  const gw = Object.create(TdaiGateway.prototype) as Gw;
  gw.sharedCosClient = null;
  gw.sharedCosInitPromise = null;
  gw.configProvider = {}; // truthy — past the early return
  const doSpy = vi.fn(async () => {});
  gw.doInitSharedCosClient = doSpy as Gw["doInitSharedCosClient"];
  return { gw, doSpy };
}

describe("TdaiGateway.initSharedCosClient", () => {
  it("dedupes concurrent init calls into a single attempt", async () => {
    const { gw, doSpy } = makeGateway();
    let release: (() => void) | undefined;
    doSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const p1 = gw.initSharedCosClient();
    const p2 = gw.initSharedCosClient(1);
    expect(doSpy).toHaveBeenCalledTimes(1);

    release?.();
    await Promise.all([p1, p2]);
    expect(gw.sharedCosInitPromise).toBeNull();
  });

  it("starts a new attempt after the previous one settled", async () => {
    const { gw, doSpy } = makeGateway();
    await gw.initSharedCosClient();
    await gw.initSharedCosClient();
    // dedupe is in-flight only; sequential calls each get an attempt
    // (in production the first success sets sharedCosClient → early return).
    expect(doSpy).toHaveBeenCalledTimes(2);
  });

  it("skips init entirely when sharedCosClient or configProvider is set/absent", async () => {
    const { gw, doSpy } = makeGateway();
    gw.sharedCosClient = { fake: true };
    await gw.initSharedCosClient();
    gw.sharedCosClient = null;
    gw.configProvider = null;
    await gw.initSharedCosClient();
    expect(doSpy).not.toHaveBeenCalled();
  });
});
