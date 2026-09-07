import { describe, expect, it } from "vitest";

import * as entrypoint from "../src/index.js";
import server from "../src/server.js";

describe("package entrypoint", () => {
  it("only exports plugin functions that OpenCode can initialize", () => {
    expect(Object.keys(entrypoint)).toEqual(["TencentDBAgentMemory"]);
    expect(Object.values(entrypoint).every((value) => typeof value === "function")).toBe(true);
  });

  it("exposes the package server entrypoint expected by OpenCode", () => {
    expect(server.id).toBe("tencentdb-agent-memory");
    expect(typeof server.server).toBe("function");
  });
});
