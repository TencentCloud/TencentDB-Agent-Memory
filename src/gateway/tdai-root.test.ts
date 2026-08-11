/**
 * tz-07 Ф1 — the root resolver. The branch that matters is WHICH root answers:
 * a wrong answer splits the tree (R1) instead of failing loudly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultTdaiRoot,
  legacyReadPath,
  resolveUnderRoot,
  resetTdaiRootCacheForTests,
} from "./tdai-root.js";

let dir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-root-"));
  resetTdaiRootCacheForTests();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  // Restore KEYS, never the object: utils/env.ts captures process.env by
  // reference, so replacing it silently detaches getEnv from the live env.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  resetTdaiRootCacheForTests();
});

describe("resolveUnderRoot", () => {
  it("builds under the root it was given, not under a global", () => {
    expect(resolveUnderRoot("/a/root", "roles", "keeper")).toBe(
      "/a/root/roles/keeper",
    );
  });
});

describe("defaultTdaiRoot", () => {
  it("TDAI_DATA_DIR wins over the config default", () => {
    process.env.TDAI_DATA_DIR = dir;
    expect(defaultTdaiRoot()).toBe(dir);
  });

  it("expands a leading tilde — an unexpanded ~ would create a literal './~' tree", () => {
    process.env.HOME = dir;
    process.env.TDAI_DATA_DIR = "~/memory";
    expect(defaultTdaiRoot()).toBe(path.join(dir, "memory"));
  });

  it("falls through to the config resolver, keeping MEMORY_TENCENTDB_ROOT alive", () => {
    delete process.env.TDAI_DATA_DIR;
    process.env.MEMORY_TENCENTDB_ROOT = dir;
    expect(defaultTdaiRoot()).toBe(path.join(dir, "memory-tdai"));
  });

  it("does no I/O per call — the root is memoized (НФТ :123)", () => {
    process.env.TDAI_DATA_DIR = dir;
    const spy = vi.spyOn(fs, "existsSync");
    for (let i = 0; i < 50; i += 1) defaultTdaiRoot();
    // Falsification: drop the memo in tdai-root.ts and this climbs with N.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    spy.mockRestore();
  });
});

describe("legacyReadPath", () => {
  it("prefers the new root when the path exists there", () => {
    fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
    expect(legacyReadPath(dir, "roles")).toBe(path.join(dir, "roles"));
  });

  it("falls back to ~/.pi only for reading, and says so once", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-home-"));
    process.env.HOME = home;
    // The fallback belongs to the install being upgraded — so the root under
    // test must BE the default root.
    process.env.TDAI_DATA_DIR = dir;
    resetTdaiRootCacheForTests();
    const legacy = path.join(home, ".pi", "agent-memory", "tdai", "roles");
    fs.mkdirSync(legacy, { recursive: true });
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    expect(legacyReadPath(dir, "roles")).toBe(legacy);
    legacyReadPath(dir, "roles");
    spy.mockRestore();
    fs.rmSync(home, { recursive: true, force: true });

    expect(writes.filter((w) => w.includes("DEPRECATED")).length).toBe(1);
  });

  it("returns the NEW path when neither exists — writes never land in legacy", () => {
    process.env.HOME = dir;
    expect(legacyReadPath(dir, "roles")).toBe(path.join(dir, "roles"));
  });
});

describe("legacyReadPath — the fallback belongs to ONE install", () => {
  it("an unrelated explicit root never inherits the host install's roles", () => {
    // Regression (found by role-files.test.ts during tz-07 Ф2): keying the
    // fallback on HOME alone made every sandbox, test and second instance read
    // the host's ~/.pi roles — the R1 split running backwards.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-host-"));
    process.env.HOME = home;
    process.env.TDAI_DATA_DIR = path.join(home, "the-default-root");
    resetTdaiRootCacheForTests();
    fs.mkdirSync(path.join(home, ".pi", "agent-memory", "tdai", "roles"), {
      recursive: true,
    });

    const other = path.join(dir, "another-instance");
    expect(legacyReadPath(other, "roles")).toBe(path.join(other, "roles"));
    fs.rmSync(home, { recursive: true, force: true });
  });
});
