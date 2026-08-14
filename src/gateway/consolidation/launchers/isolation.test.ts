/**
 * tz-06 Ф6 / L6 — only the reviewed scratch-net-v1 profile may launch.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { confineArgv, isolationRefusal, L6_SIGNED_OFF } from "./isolation.js";
import type { ResolvedRoleContract } from "../role-contract-types.js";

const contract = (profile: string | null) =>
  ({
    binding: { launcherId: "codex", isolationProfileRef: profile },
  }) as unknown as ResolvedRoleContract;

describe("tz-06 Ф6 — isolation gate", () => {
  it("signs off only the named profile", () => {
    expect(L6_SIGNED_OFF).toBe(true);
    expect(isolationRefusal(contract("scratch-net-v1"))).toBeNull();
  });

  it("refuses an unknown profile", () => {
    const err = isolationRefusal(contract("confined"));
    expect(err?.kind).toBe("isolation-unavailable");
    expect(err?.message).toContain("unknown isolation profile");
  });

  it("leaves a role that asks for nothing alone (the legacy path)", () => {
    expect(isolationRefusal(contract(null))).toBeNull();
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
    expect(args).toContain("--unshare-user");
    expect(args).not.toContain("--unshare-net");
  });
});
