/**
 * tz-06 Ф4 / L5 — a missing capability is a refusal, not a reduced launch.
 *
 * The gate lives in the registry wrapper, so the test goes through the
 * registry: a launcher that forgets to check must still be gated.
 */
import { describe, it, expect } from "vitest";
import { createLauncherRegistry } from "./registry.js";
import { checkCapabilities } from "./capabilities.js";
import type { ResolvedRoleContract } from "../role-contract-types.js";

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const contract = (requires: string[]) =>
  ({
    binding: { launcherId: "pi", model: "m", thinking: "low" },
    assets: {},
    timeoutMs: 1000,
    requiresCapabilities: requires,
  }) as unknown as ResolvedRoleContract;

const input = (requires: string[]) =>
  ({
    runId: "r1",
    attemptId: "a1",
    cwd: "/tmp",
    promptPath: "/tmp/p.md",
    taskPrompt: "t",
    env: {},
    contract: contract(requires),
  }) as never;

describe("tz-06 Ф4 — capability matrix", () => {
  const registry = () =>
    createLauncherRegistry(
      { pi: { binary: "/nonexistent/pi", flags: [] } },
      silent,
    );

  it("refuses host-incompatible BEFORE any process exists", async () => {
    const out = await registry()("pi").launch(input(["isolation"]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe("host-incompatible");
    // The refusal names what is missing — an operator fixing it blind is an
    // operator restarting the gateway five times.
    expect(out.error.message).toContain("isolation");
  });

  it("names EVERY missing capability, not the first one", () => {
    const err = checkCapabilities("pi", ["a", "b"], new Set(["b"]));
    expect(err?.message).toContain("[a]");
    const both = checkCapabilities("pi", ["a", "z"], new Set());
    expect(both?.message).toContain("[a, z]");
  });

  it("lets a role whose requirements are met through to the host", async () => {
    // Reaches the process (and fails there, on a path that does not exist) —
    // which is exactly the proof that the matrix did not stop it.
    const out = await registry()("pi").launch(input(["session", "skill"]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const res = await out.handle.completion;
    expect(res.launchError?.kind).toBe("binary-not-found");
  });

  it("an unknown launcher id is invalid-binding, not a crash", async () => {
    const out = await registry()("claude").launch(input([]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe("invalid-binding");
  });
});
