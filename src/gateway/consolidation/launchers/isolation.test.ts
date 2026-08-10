/**
 * tz-06 Ф6 / L6 — the gate is closed, and closed means refused, not
 * "launched unconfined for now".
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { confineArgv, isolationRefusal, L6_SIGNED_OFF } from "./isolation.js";
import type { ResolvedRoleContract } from "../role-contract-types.js";
import type { RoleLauncher } from "./types.js";

const launcher = (caps: string[]): RoleLauncher => ({
  id: "codex",
  capabilities: new Set(caps),
  launch: async () => {
    throw new Error("not reached");
  },
});

const contract = (profile: string | null) =>
  ({
    binding: { launcherId: "codex", isolationProfileRef: profile },
  }) as unknown as ResolvedRoleContract;

describe("tz-06 Ф6 — isolation gate", () => {
  it("is CLOSED: L6 is not signed off", () => {
    // The whole package rests on this being false. If someone flips it, this
    // test is the thing that says "that needed a security review".
    expect(L6_SIGNED_OFF).toBe(false);
  });

  it("refuses a role that asks for a profile", () => {
    const err = isolationRefusal(contract("confined"), launcher(["isolation"]));
    expect(err?.kind).toBe("isolation-unavailable");
    expect(err?.message).toContain("L6");
  });

  it("leaves a role that asks for nothing alone (the legacy path)", () => {
    expect(isolationRefusal(contract(null), launcher([]))).toBeNull();
  });

  it("binds the host binary's own directory, after the tmpfs", () => {
    // pi lives in ~/.bun/bin, not /usr — without this bind the sandbox cannot
    // exec the thing it confines. Order matters: a bind before `--tmpfs /tmp`
    // is masked by it.
    const bin = "/opt/hosts/pi";
    const { binary, args } = confineArgv("/scratch/run", bin, ["-p"]);
    expect(binary).toBe("bwrap");
    const tmpfsAt = args.indexOf("--tmpfs");
    const bindAt = args.indexOf(path.dirname(bin));
    expect(bindAt).toBeGreaterThan(tmpfsAt);
    expect(args[bindAt - 1]).toBe("--ro-bind");
    // The command itself survives the wrapping.
    expect(args.slice(-2)).toEqual([bin, "-p"]);
    expect(args).toContain("--unshare-all");
  });
});
