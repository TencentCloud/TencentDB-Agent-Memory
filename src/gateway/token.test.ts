/**
 * P2 — loopback token manager: file written OUTSIDE the memory tree
 * (sibling of dataDir) with mode 0600, stable across restarts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoopbackTokenManager } from "./token.js";

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

describe("LoopbackTokenManager (P2)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-token-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the token file as a sibling of dataDir — outside the memory tree", () => {
    const dataDir = path.join(tmp, "memory", "tdai");
    fs.mkdirSync(dataDir, { recursive: true });
    const mgr = new LoopbackTokenManager(dataDir, quiet);

    const token = mgr.ensure();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(mgr.tokenPath).toBe(path.join(tmp, "memory", "tdai-gateway.token"));
    expect(fs.existsSync(mgr.tokenPath)).toBe(true);
    // 0600 regardless of umask
    const mode = fs.statSync(mgr.tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
    // token file is NOT inside dataDir (a memory backup cannot carry it)
    expect(fs.readdirSync(dataDir)).not.toContain("tdai-gateway.token");
  });

  it("is idempotent and reuses the persisted token across instances", () => {
    const dataDir = path.join(tmp, "tdai");
    fs.mkdirSync(dataDir, { recursive: true });
    const first = new LoopbackTokenManager(dataDir, quiet).ensure();
    const again = new LoopbackTokenManager(dataDir, quiet).ensure();
    expect(again).toBe(first);
    // File content matches the in-memory token.
    expect(fs.readFileSync(path.join(tmp, "tdai-gateway.token"), "utf-8").trim()).toBe(first);
  });

  it("creates missing parent directories for dataDir", () => {
    const dataDir = path.join(tmp, "a", "b", "c", "tdai");
    const mgr = new LoopbackTokenManager(dataDir, quiet);
    expect(mgr.ensure()).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(mgr.tokenPath)).toBe(true);
  });
});
