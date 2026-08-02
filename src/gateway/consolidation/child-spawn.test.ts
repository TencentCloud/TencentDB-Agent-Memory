/**
 * P6 — child spawn/kill/sweep unit tests.
 *
 * Tests the PURE parts (env whitelist, /proc stat parsing, kill command
 * construction) plus safe smoke tests on the real /proc (no pi sub-session is
 * ever spawned here — the spawner itself is exercised through mocks in
 * orchestrator.test.ts).
 */
import { describe, it, expect } from "vitest";
import {
  buildChildEnv,
  ENV_KEEPER,
  ENV_RUN,
  ENV_GATEWAY_URL,
  parsePgrpFromStat,
  readPgrpOf,
  snapshotPgrp,
  sweepKeeperOrphans,
  killProcessGroup,
} from "./child-spawn.js";
import type { Logger } from "../../core/types.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("env whitelist (§5.1)", () => {
  it("contains EXACTLY PATH, HOME, PI_MEMORY_KEEPER, PI_MEMORY_KEEPER_RUN, TDAI_GATEWAY_URL", () => {
    const env = buildChildEnv({
      home: "/home/test",
      pathValue: "/usr/bin:/bin",
      gatewayUrl: "http://127.0.0.1:8420",
      runUuid: "uuid-123",
    });
    expect(Object.keys(env).sort()).toEqual(
      ["HOME", "PATH", ENV_KEEPER, ENV_RUN, ENV_GATEWAY_URL].sort(),
    );
    expect(env[ENV_KEEPER]).toBe("1");
    expect(env[ENV_RUN]).toBe("uuid-123");
    expect(env[ENV_GATEWAY_URL]).toBe("http://127.0.0.1:8420");
  });

  it("never carries secrets — api keys / loopback tokens are excluded by construction", () => {
    const env = buildChildEnv({
      home: "/home/test",
      pathValue: "/usr/bin:/bin",
      gatewayUrl: "http://127.0.0.1:8420",
      runUuid: "uuid-456",
    });
    const joined = JSON.stringify(env);
    expect(joined).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(joined).not.toContain("tdai-gateway.token");
    expect(joined).not.toContain("TDAI_GATEWAY_API_KEY");
    // No generic TDAI_* mask — the whitelist is explicit, nothing else leaks.
    expect(Object.keys(env).every((k) => !k.startsWith("TDAI_") || k === ENV_GATEWAY_URL)).toBe(true);
  });
});

describe("/proc stat parsing (pid-reuse-guard)", () => {
  it("parses pgrp (field 5) from a /proc/<pid>/stat line with spaces in comm", () => {
    // comm contains spaces and parens — parse must start after the LAST ')'.
    const line = "1234 (my keeper child) S 100 1234 1234 0 -1 4194304 115 0 0 0 0 0 0 0 36 16 1 0 13080789 6373376 939 18446744073709551615 93926968586240 93926968626689 140729412828992 0 0 0 0 0 0 0 0 0 17 4 0 5 0 0";
    expect(parsePgrpFromStat(line)).toBe(1234);
  });

  it("returns null on garbage", () => {
    expect(parsePgrpFromStat("no close paren")).toBeNull();
    expect(parsePgrpFromStat("")).toBeNull();
  });

  it("readPgrpOf(process.pid) is our own live pgrp (smoke)", () => {
    const pgrp = readPgrpOf(process.pid);
    expect(pgrp).toBeTypeOf("number");
    expect(pgrp).toBeGreaterThan(0);
  });

  it("snapshotPgrp(-1) is empty (no such group) — safe walk", () => {
    expect(snapshotPgrp(-1)).toEqual([]);
  });

  it("killProcessGroup with a nonexistent group returns false (ESRCH, no throw)", () => {
    // -999999 cannot exist — the kill(1) binary reports failure, not a throw.
    expect(killProcessGroup(999_999)).toBe(false);
  });

  it("orphan sweep finds nothing on a clean system (no keeper processes)", () => {
    expect(sweepKeeperOrphans(null, silentLogger)).toBe(0);
    expect(sweepKeeperOrphans("some-active-run", silentLogger)).toBe(0);
  });
});
