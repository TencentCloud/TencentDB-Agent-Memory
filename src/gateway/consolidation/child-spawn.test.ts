/**
 * P6 — child spawn/kill/sweep unit tests.
 *
 * Tests the PURE parts (env whitelist, /proc stat parsing, kill command
 * construction) plus safe smoke tests on the real /proc (no pi sub-session is
 * ever spawned here — the spawner itself is exercised through mocks in
 * orchestrator.test.ts).
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import {
  buildChildEnv,
  ENV_KEEPER,
  ENV_RUN,
  ENV_OWNER,
  ENV_GATEWAY_URL,
  parsePgrpFromStat,
  readPgrpOf,
  snapshotPgrp,
  scanKeeperProcesses,
  sweepKeeperOrphans,
  killProcessGroup,
  killPid,
} from "./child-spawn.js";
import type { Logger } from "../../core/types.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("env whitelist (§5.1)", () => {
  it("contains EXACTLY PATH, HOME, PI_MEMORY_KEEPER, PI_MEMORY_KEEPER_OWNER, PI_MEMORY_KEEPER_RUN, TDAI_GATEWAY_URL", () => {
    const env = buildChildEnv({
      home: "/home/test",
      pathValue: "/usr/bin:/bin",
      gatewayUrl: "http://127.0.0.1:8420",
      runUuid: "uuid-123",
      ownerPid: 4242,
    });
    expect(Object.keys(env).sort()).toEqual(
      ["HOME", "PATH", ENV_KEEPER, ENV_OWNER, ENV_RUN, ENV_GATEWAY_URL].sort(),
    );
    expect(env[ENV_KEEPER]).toBe("1");
    expect(env[ENV_OWNER]).toBe("4242");
    expect(env[ENV_RUN]).toBe("uuid-123");
    expect(env[ENV_GATEWAY_URL]).toBe("http://127.0.0.1:8420");
  });

  it("never carries secrets — api keys / loopback tokens are excluded by construction", () => {
    const env = buildChildEnv({
      home: "/home/test",
      pathValue: "/usr/bin:/bin",
      gatewayUrl: "http://127.0.0.1:8420",
      runUuid: "uuid-456",
      ownerPid: 4242,
    });
    const joined = JSON.stringify(env);
    expect(joined).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(joined).not.toContain("tdai-gateway.token");
    expect(joined).not.toContain("TDAI_GATEWAY_API_KEY");
    // No generic TDAI_* mask — the whitelist is explicit, nothing else leaks.
    expect(
      Object.keys(env).every(
        (k) => !k.startsWith("TDAI_") || k === ENV_GATEWAY_URL,
      ),
    ).toBe(true);
  });
});

describe("/proc stat parsing (pid-reuse-guard)", () => {
  it("parses pgrp (field 5) from a /proc/<pid>/stat line with spaces in comm", () => {
    // comm contains spaces and parens — parse must start after the LAST ')'.
    const line =
      "1234 (my keeper child) S 100 1234 1234 0 -1 4194304 115 0 0 0 0 0 0 0 36 16 1 0 13080789 6373376 939 18446744073709551615 93926968586240 93926968626689 140729412828992 0 0 0 0 0 0 0 0 0 17 4 0 5 0 0";
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

  it("orphan sweep does not kill a live keeper protected by its RUN-uuid", () => {
    // A production gateway may legitimately have keeper sub-sessions running
    // (PI_MEMORY_KEEPER=1 in /proc) — this test must be robust to that, never
    // asserting an absolute 0 (test isolation, cf. acceptance B6 r2 stub).
    const live = scanKeeperProcesses();
    if (live.length === 0) {
      // Clean system: sweep finds nothing.
      expect(sweepKeeperOrphans(null, silentLogger)).toBe(0);
      expect(
        sweepKeeperOrphans(new Set(["some-active-run"]), silentLogger),
      ).toBe(0);
      return;
    }
    // Live keepers exist: protect ALL their RUN-uuids (not just the first —
    // a single-uuid set would kill parallel-role keepers of a live gateway).
    const protect = new Set(
      live.map((c) => c.runUuid).filter((u): u is string => u !== null),
    );
    if (protect.size > 0) {
      expect(sweepKeeperOrphans(protect, silentLogger)).toBe(0);
    }
    // NOTE: never sweep with an empty/null set here — that would SIGKILL the
    // live keepers exactly when one exists (test isolation).
  });

  it("orphan sweep KILLS a foreign keeper (RUN-uuid not in active set)", async () => {
    // Guard: a live gateway on this host may legitimately run keeper
    // sub-sessions (PI_MEMORY_KEEPER=1) — the sweep must NEVER kill those.
    // Protect their RUN-uuids in the active set; cleanup is killPid of OUR
    // throwaway only (never a blanket sweep(null), which would SIGKILL
    // pre-existing live keepers mid-run).
    const preExisting = scanKeeperProcesses();
    const protect = new Set(
      preExisting.map((c) => c.runUuid).filter((u): u is string => u !== null),
    );
    protect.add("some-other-run");

    // Spawn a throwaway PI_MEMORY_KEEPER=1 process with a FOREIGN RUN-uuid.
    const foreignRun = "foreign-1234";
    const child = spawn("bash", ["-c", "sleep 30"], {
      env: {
        ...process.env,
        PI_MEMORY_KEEPER: "1",
        PI_MEMORY_KEEPER_RUN: foreignRun,
      },
      detached: true,
      stdio: "ignore",
    });
    // Wait for the marker to be visible in /proc (environ write is atomic on
    // spawn; a short tick guards against the read racing the exec).
    await new Promise((r) => setTimeout(r, 300));
    const before = scanKeeperProcesses();
    const mine = before.filter((c) => c.runUuid === foreignRun);
    expect(mine.length).toBeGreaterThanOrEqual(1);

    try {
      // Active set protects pre-existing keepers but NOT the foreign uuid →
      // only our throwaway is killed.
      const killed = sweepKeeperOrphans(protect, silentLogger);
      expect(killed).toBeGreaterThanOrEqual(1);
    } finally {
      // Cleanup: kill our throwaway by pid — never a blanket sweep.
      if (child.pid) killPid(child.pid);
    }
  });
});
