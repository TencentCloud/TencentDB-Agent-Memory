/**
 * tz-06 Ф4 / L5 — a missing capability is a refusal, not a reduced launch.
 *
 * The gate lives on the service boundary (defaultSpawnChild), NOT in the
 * registry: `ctx.launcherFor` is a seam a caller can hand a raw launcher
 * through, so a gate inside the registry is a gate with a way around it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLauncherRegistry } from "./registry.js";
import { checkCapabilities } from "./capabilities.js";
import { defaultSpawnChild } from "../runner-helpers.js";
import type { ResolvedRoleContract } from "../role-contract-types.js";

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const contract = (requires: string[], launcherId = "pi") =>
  ({
    binding: { launcherId, model: "m", thinking: "low" },
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
      {
        pi: { binary: "/nonexistent/pi", flags: [] },
        claude: { binary: "/nonexistent/claude", flags: [] },
      },
      silent,
    );

  const ctx = (launcherFor: (id: string) => unknown = registry()) =>
    ({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "tz06-caps-")),
      now: () => Date.now(),
      childrenRef: { value: new Map() },
      launcherFor,
      logger: silent,
    }) as never;

  const childCtx = (requires: string[], launcherId = "pi") =>
    ({
      runId: "r1",
      attemptId: "a1",
      cwd: os.tmpdir(),
      promptPath: path.join(os.tmpdir(), "p.md"),
      taskPrompt: "t",
      env: {},
      contract: contract(requires, launcherId),
    }) as never;

  it("refuses host-incompatible BEFORE any process exists", async () => {
    // `extension` and not `isolation`: confinement is the host-agnostic bwrap
    // wrapper, so every launcher provides it — a role's own extension bundle
    // is a knob claude genuinely does not have.
    const res = await defaultSpawnChild(
      ctx(),
      childCtx(["extension"], "claude"),
    );
    // The refusal names what is missing — an operator fixing it blind is an
    // operator restarting the gateway five times.
    expect(res.error).toContain("host-incompatible");
    expect(res.error).toContain("extension");
  });

  it("gates a RAW launcher handed in past the registry", async () => {
    const raw = {
      id: "hand-rolled",
      capabilities: new Set<string>(),
      launch: async () => {
        throw new Error("must never be reached");
      },
    };
    const res = await defaultSpawnChild(
      ctx(() => raw),
      childCtx(["session"]),
    );
    expect(res.error).toContain("host-incompatible");
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
    const res = await defaultSpawnChild(ctx(), childCtx(["session", "skill"]));
    expect(res.error).toContain("binary-not-found");
  });

  it("an unknown launcher id is invalid-binding, not a crash", async () => {
    const out = await registry()("nope").launch(input([]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe("invalid-binding");
  });
});
