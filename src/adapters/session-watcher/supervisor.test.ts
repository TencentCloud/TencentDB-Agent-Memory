import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resolveGatewayServerPath } from "./supervisor.js";

describe("GatewaySupervisor", () => {
  it("resolves the gateway server to an existing file", () => {
    const p = resolveGatewayServerPath();
    expect(fs.existsSync(p)).toBe(true);
    expect(path.basename(p)).toBe("server.ts");
    // supervisor.ts lives under src/adapters/session-watcher/, so the
    // resolved gateway path must NOT contain a duplicated src segment.
    expect(p.replace(/\\/g, "/")).not.toMatch(/\/src\/src\//);
  });
});
