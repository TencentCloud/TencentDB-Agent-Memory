import { describe, expect, it } from "vitest";
import { resolveForAgent, shouldOverride, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";

function row(partial: Partial<InstanceUpstreamRow>): InstanceUpstreamRow {
  return {
    group_id: "g", group_type: "custom", name: "n", agents: ["codex"], enabled: true,
    mode: "subscription_pool", base_url: "", api_key: "", model_id: "", ...partial,
  };
}
const dflt = row({ group_id: "d", group_type: "default", mode: "official", agents: ["claude-code", "codex"] });

describe("resolveForAgent with subscription_pool groups", () => {
  it("returns kind pool for an enabled pool group covering the agent", () => {
    const pool = row({});
    expect(resolveForAgent([dflt, pool], "codex")).toEqual({ kind: "pool", row: pool });
  });

  it("an agent outside the pool group still resolves to the default group", () => {
    expect(resolveForAgent([dflt, row({})], "claude-code")).toEqual({ kind: "official", row: dflt });
  });

  it("a disabled pool group blocks the agent like any custom group", () => {
    expect(resolveForAgent([dflt, row({ enabled: false })], "codex")).toEqual({
      kind: "blocked", reason: "custom_disabled", group_id: "g",
    });
  });

  it("other custom modes keep resolving to override", () => {
    const custom = row({ mode: "custom_unified", base_url: "http://x" });
    expect(resolveForAgent([dflt, custom], "codex")).toEqual({ kind: "override", row: custom });
  });

  it("shouldOverride stays false for a pool resolution", () => {
    expect(shouldOverride(resolveForAgent([dflt, row({})], "codex"))).toBe(false);
  });
});
