import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "./loopback.js";

describe("isLoopbackHost", () => {
  it("accepts loopback host variants", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "127.0.0.2",
      "127.255.255.254",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "2130706433",
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it("rejects wildcard and remote hosts", () => {
    for (const host of [
      "",
      "0.0.0.0",
      "192.168.1.10",
      "8.8.8.8",
      "::",
      "example.com",
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});
