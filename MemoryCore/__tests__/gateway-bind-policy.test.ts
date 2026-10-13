import { describe, expect, it } from "vitest";
import { TdaiGateway, assertGatewayAuthBoundary } from "../src/gateway/server.js";

describe("Gateway bind authentication boundary", () => {
  it.each(["127.0.0.1", "::1", "localhost"])("preserves keyless loopback development: %s", host => {
    expect(() => assertGatewayAuthBoundary({ host })).not.toThrow();
  });
  it.each(["0.0.0.0", "::", "192.0.2.1"])("rejects keyless non-loopback listeners: %s", host => {
    expect(() => assertGatewayAuthBoundary({ host })).toThrow("requires TDAI_GATEWAY_API_KEY");
  });
  it("permits configured authentication or an explicit insecure opt-in", () => {
    expect(() => assertGatewayAuthBoundary({ host: "0.0.0.0", apiKey: "synthetic-gateway-key" })).not.toThrow();
    expect(() => assertGatewayAuthBoundary({ host: "0.0.0.0", allowInsecureNoKeyListen: true })).not.toThrow();
  });
  it("rejects actual gateway start before storage initialization", async () => {
    const config = { server: { host: "0.0.0.0" }, get data(): never { throw new Error("storage was accessed"); } };
    // Invoke the real start method with a checked synthetic receiver. No Core
    // constructor, native engine, network listener or production data is used.
    await expect(TdaiGateway.prototype.start.call({ config } as unknown as TdaiGateway)).rejects.toThrow("requires TDAI_GATEWAY_API_KEY");
  });
});
