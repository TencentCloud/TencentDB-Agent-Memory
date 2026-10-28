/**
 * ensureMetadataService in-flight dedupe: concurrent first requests for
 * the same instance must share one build promise (previously the Map was
 * checked, then awaited, then set — so two racing requests each built
 * their own MetadataService and ran initDefaults twice).
 */
import { describe, it, expect, vi } from "vitest";
import { TdaiGateway } from "./server.js";

type Gw = {
  metadataServiceByInstance: Map<string, Promise<unknown>>;
  buildMetadataService: (instanceId: string) => Promise<unknown>;
  ensureMetadataService: (instanceId: string) => Promise<unknown>;
};

function makeGateway(buildImpl: (iid: string) => Promise<unknown>): {
  gw: Gw;
  buildSpy: ReturnType<typeof vi.fn>;
} {
  const gw = Object.create(TdaiGateway.prototype) as Gw;
  gw.metadataServiceByInstance = new Map();
  const buildSpy = vi.fn(buildImpl);
  gw.buildMetadataService = buildSpy as Gw["buildMetadataService"];
  return { gw, buildSpy };
}

describe("TdaiGateway.ensureMetadataService", () => {
  it("dedupes concurrent first builds for the same instance", async () => {
    let resolveBuild: ((v: unknown) => void) | undefined;
    const { gw, buildSpy } = makeGateway(
      (iid) =>
        new Promise((resolve) => {
          resolveBuild = resolve;
        }).then(() => ({ iid })),
    );

    const p1 = gw.ensureMetadataService("inst-A");
    const p2 = gw.ensureMetadataService("inst-A");
    expect(buildSpy).toHaveBeenCalledTimes(1);

    resolveBuild?.(undefined);
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1).toBe(s2);
    expect(s1).toEqual({ iid: "inst-A" });
  });

  it("still caches per-instance (different instances build separately)", async () => {
    const { gw, buildSpy } = makeGateway(async (iid) => ({ iid }));
    const [a, b] = await Promise.all([
      gw.ensureMetadataService("inst-A"),
      gw.ensureMetadataService("inst-B"),
    ]);
    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
  });

  it("evicts the entry on rejection so the next call rebuilds", async () => {
    let calls = 0;
    const { gw, buildSpy } = makeGateway(async () => {
      calls += 1;
      if (calls === 1) throw new Error("store unavailable");
      return { ok: true };
    });

    await expect(gw.ensureMetadataService("inst-A")).rejects.toThrow("store unavailable");
    // Wait a tick so the eviction .catch() runs.
    await new Promise((r) => setImmediate(r));
    expect(gw.metadataServiceByInstance.has("inst-A")).toBe(false);

    await expect(gw.ensureMetadataService("inst-A")).resolves.toEqual({ ok: true });
    expect(buildSpy).toHaveBeenCalledTimes(2);
  });
});
